// Privacy gate for docos. Postgres-backed.

import {
  type DocoRole,
  getDocoByIdOrHandle,
  getDocoUserGrant,
  getDocoUserRole,
  getPrincipalById,
  getWorkspaceGrant,
  getWorkspaceRole,
  listDocoIdsForUser,
  maxRole,
  roleAtLeast,
  withClient,
} from "@doco/db";
import {
  type DocoHandle,
  WRITE_ALL,
  type WritableType,
  canWriteType,
  isWritableType,
  normalizeWriteTypes,
} from "@doco/shared";
import { waitUntil } from "@vercel/functions";
import { redirect } from "react-router";
import { AUTHORING_SURFACE_HEADER } from "./authoring-source.server";
import { docoPath } from "./db.server";
import { type DocoMetadata, readDocoMetadata } from "./doco-metadata.server";
import { type ValidAccessToken, validateAccessToken } from "./oauth-server.server";
import { readCreatedDocoIdSearchParam } from "./post-create-doco-route";
import { type ProjectToken, isProjectToken, validateProjectToken } from "./project-tokens.server";
import { recordQuery } from "./query-log.server";
import { type CurrentPrincipal, extractBearer, getCurrentPrincipalAsync } from "./session.server";

/**
 * Señor Doco — the in-page web assistant and the Slack bot — runs every
 * `doco_api` call as the signed-in / linked HUMAN's session, so without a
 * ceiling it would inherit that human's full role, `owner` included.
 * Product rule: the agent must never exceed this. Owner-tier operations
 * (editing policies, changing settings, deleting Docos, owner-level invites,
 * managing project tokens, and creating Docos/workspaces) stay human-only on
 * both surfaces.
 */
export const SENOR_DOCO_ROLE_CEILING: DocoRole = "writer";

/**
 * True when the request originates from Señor Doco (web in-page assistant or
 * Slack). Both surfaces stamp an authoring-surface header on their `doco_api`
 * tool calls; the user-agent is a belt-and-suspenders fallback. Spoofing the
 * header can only LOWER a caller's effective role — it never widens access —
 * so trusting these client-supplied signals here is safe.
 */
export function isSenorDocoRequest(request: Request): boolean {
  const surface = request.headers.get(AUTHORING_SURFACE_HEADER)?.trim().toLowerCase();
  if (surface === "senor-doco-web" || surface === "slack") return true;
  const ua = request.headers.get("user-agent") ?? "";
  return /Doco-In-Page-Assistant|Doco-Slack-Assistant/i.test(ua);
}

/**
 * An agent reading a Doco: a GET made with a token (MCP, the REST API, a
 * project token) or by Señor Doco. Each one is a query in the query log; a
 * person opening a page on the website isn't.
 */
export function isAgentRead(request: Request): boolean {
  return request.method === "GET" && (!!extractBearer(request) || isSenorDocoRequest(request));
}

/**
 * Cap a resolved role to the Señor Doco ceiling when the request is the
 * agent. Owner is the only role above the ceiling, so anything ≥ owner
 * collapses to `writer`; reader / writer (and null) pass through unchanged.
 * Non-agent requests are never capped.
 */
export function capRoleForRequest(role: DocoRole | null, request: Request): DocoRole | null {
  if (!role || !isSenorDocoRequest(request)) return role;
  return roleAtLeast(role, "owner") ? SENOR_DOCO_ROLE_CEILING : role;
}

/** The lower-power of two roles (the combined ceiling when both apply). */
function lowerRole(a: DocoRole, b: DocoRole): DocoRole {
  return roleAtLeast(a, b) ? b : a;
}

/** Cap a role at a ceiling (the lower of the two). null role/ceiling pass through. */
function capRole(role: DocoRole | null, ceiling: DocoRole | null): DocoRole | null {
  if (!role || !ceiling) return role;
  return lowerRole(role, ceiling);
}

/**
 * The role ceiling this REQUEST imposes on the underlying human's live role —
 * or null for "no ceiling" (full owner). Two independent caps combine to the
 * lower: the Señor Doco agent cap (writer), and an actor token's `actor_role`.
 * An actor access token carries no stored grants — it acts as its user, and
 * THIS is what holds it to the role the human approved when minting it.
 */
export async function requestRoleCeiling(request: Request): Promise<DocoRole | null> {
  let ceiling: DocoRole | null = isSenorDocoRequest(request) ? SENOR_DOCO_ROLE_CEILING : null;
  const token = await getOauthTokenForRequest(request);
  if (token?.grant_type === "actor" && token.actor_role) {
    ceiling = ceiling ? lowerRole(ceiling, token.actor_role) : token.actor_role;
  }
  return ceiling;
}

/** True when the request's bearer is an "all workspaces" actor token. */
async function isActorTokenRequest(request: Request): Promise<boolean> {
  return (await getOauthTokenForRequest(request))?.grant_type === "actor";
}

/**
 * Doco-level role for this principal — max of (direct owner_id match,
 * workspace-membership role on the owning workspace, explicit doco_users row).
 *
 * Returns null when the principal has no doco-level grant.
 */
export async function getDocoLevelRole(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<DocoRole | null> {
  // Delegate to getDocoLevelGrant so the role and per-type-write paths
  // resolve access from exactly the same sources (direct owner, workspace
  // membership, doco membership) — there is no second copy of the source
  // list to drift out of sync.
  const grant = await getDocoLevelGrant(meta, principalId);
  return grant?.role ?? null;
}

/**
 * `getDocoLevelRole`, capped to the Señor Doco ceiling for agent requests
 * (see `capRoleForRequest`). Owner-gated routes that resolve a role directly —
 * policy capture, invites — call this so the agent can never present as owner
 * even when the underlying human is one.
 */
export async function getDocoLevelRoleForRequest(
  request: Request,
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<DocoRole | null> {
  // Cap at the request ceiling — the Señor Doco agent cap AND, for an actor
  // token, the approved actor_role (resolved live against the human's role).
  return capRole(await getDocoLevelRole(meta, principalId), await requestRoleCeiling(request));
}

/**
 * Like `getDocoLevelRole`, but also resolves the per-type WRITE set
 * (decision_per_type_write_grants). The effective grant is the strongest
 * role across all sources unioned with every source's write-type set: a
 * principal who is a writer-on-decisions via workspace membership and a
 * writer-on-actions via a direct doco_users row can write both. An owner
 * from any source writes everything (represented as the wildcard).
 *
 * Returns null when the principal has no doco-level grant at all.
 */
export async function getDocoLevelGrant(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<{ role: DocoRole; writeTypes: string[] } | null> {
  if (!principalId) return null;

  let role: DocoRole | null = null;
  const writeTypes = new Set<string>();
  const ownerOfPrincipal = await getPrincipalOwnerId(principalId);

  const fold = (grant: { role: DocoRole; writeTypes: string[] } | null) => {
    if (!grant) return;
    role = maxRole(role, grant.role);
    if (grant.role === "owner") writeTypes.add(WRITE_ALL);
    for (const t of grant.writeTypes) writeTypes.add(t);
  };

  if (meta.ownerId === principalId) fold({ role: "owner", writeTypes: [WRITE_ALL] });
  if (ownerOfPrincipal && ownerOfPrincipal === meta.ownerId) {
    fold({ role: "owner", writeTypes: [WRITE_ALL] });
  }

  if (meta.ownerId.startsWith("workspace_")) {
    fold(await getWorkspaceGrant(meta.ownerId, principalId));
  }

  if (meta.docoId) {
    fold(await getDocoUserGrant(meta.docoId, principalId));
  }

  if (!role) return null;
  return { role, writeTypes: normalizeWriteTypes([...writeTypes]) };
}

/**
 * Per-type write gate: can `principalId` write nodes/edges of
 * `type` in this Doco? Combines the Doco-level grant (role + write-type
 * set) via `canWriteType` — owners write everything; otherwise the type
 * must be covered by the wildcard or named explicitly.
 *
 * The `policy` type is NOT write-gateable content — policies configure the
 * Doco and stay owner-only, matching `canEditPolicies`. Any non-writable type therefore requires
 * the owner role.
 *
 * This does NOT enforce the OAuth-token scope-down; for bearer-auth API
 * routes the caller still routes through the token gate
 * (`enforceOauthGrant`) which now also narrows per type.
 */
export async function canWriteDocoType(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
  type: string,
): Promise<boolean> {
  if (!principalId) return false;
  const grant = await getDocoLevelGrant(meta, principalId);
  if (!grant) return false;
  if (!isWritableType(type)) return grant.role === "owner";
  return canWriteType(grant.role, grant.writeTypes, type as WritableType);
}

/**
 * The token's per-type write cap for this Doco, or null when there is no
 * bearer token (cookie-session request → no scope-down). When a token IS
 * present, the returned set caps the membership grant: the principal may
 * write a type only if BOTH the membership grant and this set allow it.
 *
 * A token that granted writer (wildcard) on the target returns ["*"]; a
 * token that granted only specific types returns those; a token scoped
 * to the Doco/workspace but with no write returns []. Owner grants without a
 * per-type entry retain the owner wildcard.
 */
function tokenWriteTypeCap(
  token: ValidAccessToken | null,
  meta: { ownerId: string; docoId?: string },
): string[] | null {
  if (!token) return null;
  const caps = new Set<string>();
  let matched = false;

  if (meta.docoId && token.granted_doco_ids.includes(meta.docoId)) {
    matched = true;
    addTokenWriteCap(
      caps,
      token.granted_doco_roles?.[meta.docoId],
      token.granted_doco_write_types?.[meta.docoId],
    );
  }
  if (meta.ownerId.startsWith("workspace_") && token.granted_workspace_ids.includes(meta.ownerId)) {
    matched = true;
    addTokenWriteCap(
      caps,
      token.granted_workspace_roles?.[meta.ownerId],
      token.granted_workspace_write_types?.[meta.ownerId],
    );
  }

  if (!matched) return [];
  return normalizeWriteTypes([...caps]);
}

function addTokenWriteCap(caps: Set<string>, role: string | undefined, rawWriteTypes: unknown) {
  const writeTypes = normalizeWriteTypes(rawWriteTypes);
  if (writeTypes.length > 0) {
    for (const t of writeTypes) caps.add(t);
    return;
  }
  if (role === "owner" || role === "writer") caps.add(WRITE_ALL);
}

/**
 * Request-aware per-type write gate (the unified human + agent path).
 * Effective write on `type` = membership grant allows it AND, when a
 * bearer token is attached, the token's per-type cap allows it too.
 * Cookie-session requests carry no token and fall back to membership.
 *
 * This is what content-mutation routes (capture / update) call.
 */
export async function canWriteDocoTypeForRequest(
  request: Request,
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
  type: string,
): Promise<boolean> {
  if (!(await canWriteDocoType(meta, principalId, type))) return false;
  const ceiling = await requestRoleCeiling(request);
  // Policy types are owner-only and not token-scopeable per type; the
  // membership check above already required owner. Any request ceiling below
  // owner (Señor Doco's writer cap, or an actor reader/writer ceiling) denies
  // those types even when the underlying human is an owner.
  if (!isWritableType(type)) return ceiling === null;
  // A reader ceiling forbids writes outright (an actor token approved at reader).
  if (ceiling === "reader") return false;

  const token = await getOauthTokenForRequest(request);
  // An actor token carries no per-type caps — the ceiling above governs it.
  // A regular token narrows per type to exactly what it was granted.
  if (token && token.grant_type !== "actor") {
    const cap = tokenWriteTypeCap(token, meta);
    if (cap !== null && !canWriteType("reader", cap, type as WritableType)) return false;
  }
  return true;
}

export async function requireDocoTypeWriteForRequest(
  request: Request,
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
  type: string,
  verb = "write",
): Promise<Response | null> {
  const mayWrite = await canWriteDocoTypeForRequest(request, meta, principalId, type);
  if (mayWrite) return null;
  return Response.json(
    { error: `Forbidden: write access on '${type}' required to ${verb}.` },
    { status: 403 },
  );
}

export async function requireDocoTypeWritesForRequest(
  request: Request,
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
  types: Iterable<string>,
  verb = "write",
): Promise<Response | null> {
  for (const type of [...new Set(types)]) {
    const denied = await requireDocoTypeWriteForRequest(request, meta, principalId, type, verb);
    if (denied) return denied;
  }
  return null;
}

/**
 * Can `principalId` read this Doco?
 *
 *   - public visibility → always yes (anonymous OK).
 *   - host-bootstrap-owned (unclaimed) → always yes regardless of visibility.
 *   - private visibility: any doco-level grant → yes.
 */
export async function canAccessDoco(
  meta: { ownerId: string; visibility: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (meta.visibility === "public") return true;
  if (await isHostBootstrapOwned(meta.ownerId)) return true;
  if (!principalId) return false;

  const docoLevel = await getDocoLevelRole(meta, principalId);
  if (docoLevel) return true;

  return false;
}

/**
 * The validated OAuth access token attached to this request, or null.
 *
 * Returns null for cookie-only sessions, anonymous requests, and
 * bearer tokens that fail validation (revoked / expired / unknown).
 * Use this from API endpoints that need to filter listings by the
 * token's grants — for single-Doco endpoints that should fail loudly
 * on an invalid bearer, route through `loadDocoForRead` instead, which
 * also emits the RFC 6750 `WWW-Authenticate` header.
 */
export async function getOauthTokenForRequest(request: Request): Promise<ValidAccessToken | null> {
  const bearer = extractBearer(request);
  if (!bearer) return null;
  return await validateAccessToken(bearer);
}

/** True if the OAuth token's grants cover this Doco (per-Doco or per-workspace). */
export function oauthTokenGrantsDoco(
  token: ValidAccessToken,
  meta: { ownerId: string; docoId: string },
): boolean {
  // An actor token carries no stored grants — it acts as the human, so it
  // "grants" every Doco the human can reach. Callers pass the human's own
  // accessible set here, so this widens to that set; real per-Doco access is
  // still enforced live by enforceOauthGrant / canAccessDoco.
  if (token.grant_type === "actor") return true;
  if (token.granted_doco_ids.includes(meta.docoId)) return true;
  if (
    meta.ownerId.startsWith("workspace_") &&
    (token.granted_workspace_ids ?? []).includes(meta.ownerId)
  ) {
    return true;
  }
  return false;
}

/**
 * owner_id for each given Doco id (ids without a row are omitted). The
 * listing gates below use this to learn which workspace owns each Doco.
 */
async function loadDocoOwnerIds(docoIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(docoIds)].filter(Boolean);
  if (ids.length === 0) return out;
  await withClient(async (c) => {
    const r = await c.query<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM docos WHERE id = ANY($1::text[]) AND deleted_at IS NULL",
      [ids],
    );
    for (const row of r.rows) out.set(String(row.id), String(row.owner_id));
  });
  return out;
}

/**
 * Workspaces an OAuth token may "touch" for listing purposes: the
 * workspaces granted to it directly, unioned with the workspace that owns any
 * individually-granted Doco (so a Doco-scoped token still counts as
 * being "in" that Doco's workspace). `ownerByGrantedDocoId` maps each
 * `granted_doco_ids` entry to its owner_id.
 */
export function tokenReachableWorkspaceIdsFromGrant(
  token: Pick<ValidAccessToken, "granted_doco_ids" | "granted_workspace_ids">,
  ownerByGrantedDocoId: ReadonlyMap<string, string>,
): Set<string> {
  const workspaces = new Set<string>(
    (token.granted_workspace_ids ?? []).filter((id) => id.startsWith("workspace_")),
  );
  for (const docoId of token.granted_doco_ids ?? []) {
    const owner = ownerByGrantedDocoId.get(docoId);
    if (owner?.startsWith("workspace_")) workspaces.add(owner);
  }
  return workspaces;
}

/**
 * Narrow a principal's accessible-Doco set to what an OAuth token may
 * ENUMERATE, enforcing the same workspace boundary the read gate
 * (`oauthTokenGrantsDoco`) enforces — widened only to same-workspace siblings.
 *
 * A Doco survives iff it is individually granted, OR its owning workspace is
 * one the token can reach (`tokenReachableWorkspaceIdsFromGrant`). This keeps
 * references WITHIN an workspace (a token scoped to one Doco can see
 * its siblings) but blocks a token from learning the names of Docos in a
 * DIFFERENT workspace it was never granted — the cross-workspace leak a
 * scoped token would otherwise get from `listAccessibleDocoIdsForPrincipal`,
 * which unions every workspace the underlying human belongs to. Personal
 * (principal-owned) Docos have no workspace, so they appear only when granted
 * directly. Always a subset of the principal set: never widens access.
 */
export function filterDocosToWorkspaceBoundary(
  accessibleDocoIds: readonly string[],
  ownerByDocoId: ReadonlyMap<string, string>,
  token: Pick<ValidAccessToken, "granted_doco_ids" | "granted_workspace_ids">,
): string[] {
  const grantedDocoIds = new Set(token.granted_doco_ids ?? []);
  const reachableWorkspaces = tokenReachableWorkspaceIdsFromGrant(token, ownerByDocoId);
  return accessibleDocoIds.filter((id) => {
    if (grantedDocoIds.has(id)) return true;
    const ownerId = ownerByDocoId.get(id);
    return !!ownerId && ownerId.startsWith("workspace_") && reachableWorkspaces.has(ownerId);
  });
}

/**
 * The Docos a REQUEST may enumerate in `/api/v1/docos.json` and similar
 * listings. Cookie / anonymous requests (no bearer) get the full
 * principal set unchanged — the OAuth approve screen wants everything
 * the human can reach. A bearer-token request is narrowed to
 * the token's workspace boundary (see `filterDocosToWorkspaceBoundary`) so
 * a token scoped to one Doco never leaks the names of Docos in another
 * workspace.
 */
export async function listVisibleDocoIdsForRequest(
  request: Request,
  principalId: string,
): Promise<string[]> {
  const accessible = await listAccessibleDocoIdsForPrincipal(principalId);
  const token = await getOauthTokenForRequest(request);
  // An actor token acts as the human: it enumerates everything they can reach,
  // across all their workspaces (no narrowing). A regular
  // token is narrowed to its granted workspace boundary below.
  if (!token || token.grant_type === "actor" || accessible.length === 0) return accessible;
  const ownerByDocoId = await loadDocoOwnerIds([...accessible, ...(token.granted_doco_ids ?? [])]);
  return filterDocosToWorkspaceBoundary(accessible, ownerByDocoId, token);
}

/**
 * The workspace-id set a bearer-token request may enumerate in
 * `/api/v1/workspaces.json`, or `null` for cookie / anonymous requests (which
 * keep their full membership listing). Mirrors the Doco boundary above:
 * a scoped token only sees workspaces it can reach, never every workspace the
 * underlying human belongs to.
 */
export async function tokenReachableWorkspaceIdsForRequest(
  request: Request,
): Promise<Set<string> | null> {
  const token = await getOauthTokenForRequest(request);
  // No bearer, or an actor token (acts as the human → full membership listing):
  // no workspace narrowing to apply.
  if (!token || token.grant_type === "actor") return null;
  const ownerByDocoId = await loadDocoOwnerIds(token.granted_doco_ids ?? []);
  return tokenReachableWorkspaceIdsFromGrant(token, ownerByDocoId);
}

/**
 * Read-access predicate for API endpoints that don't already go through
 * `loadDocoForRead`. Layers OAuth-token scope-down on top of the
 * principal-level `canAccessDoco`:
 *
 *   - No bearer (cookie or anonymous): falls back to `canAccessDoco`.
 *   - Valid bearer that grants this Doco (per-Doco or per-workspace): falls
 *     back to `canAccessDoco`.
 *   - Bearer present but invalid, or valid but doesn't grant: returns
 *     false — the caller should respond the same way it would for a
 *     principal-level access denial (so the OAuth grant scope-down can
 *     never widen what a token sees beyond what the principal sees).
 */
export async function canReadDocoForRequest(
  request: Request,
  meta: { ownerId: string; visibility: string; docoId: string },
  principalId: string | null,
): Promise<boolean> {
  const bearer = extractBearer(request);
  if (bearer) {
    const token = await validateAccessToken(bearer);
    if (!token) return false;
    if (!oauthTokenGrantsDoco(token, meta)) return false;
  }
  return await canAccessDoco(meta, principalId);
}

/** True if ownerId is the host-bootstrap placeholder Principal (unclaimed docos). */
async function isHostBootstrapOwned(ownerId: string): Promise<boolean> {
  if (!ownerId.startsWith("principal_")) return false;
  const p = await getPrincipalById(ownerId);
  return p?.prose === "host-bootstrap";
}

/** Read the owner_id field for either a user identity or Principal node. */
async function getPrincipalOwnerId(principalId: string): Promise<string | null> {
  if (!principalId.startsWith("principal_")) return null;
  const p = await getPrincipalById(principalId);
  if (!p) return null;
  const ownerId = p.extra.owner_id;
  if (typeof ownerId !== "string") return null;
  if (
    !ownerId.startsWith("principal_") &&
    !ownerId.startsWith("user_") &&
    !ownerId.startsWith("workspace_")
  ) {
    return null;
  }
  return ownerId;
}

/**
 * Every Doco the principal can read or write — the union of three
 * sources:
 *   1. Docos they own directly (`docos.owner_id = user_id`)
 *   2. Docos owned by an workspace they belong to (any role in `workspace_users`)
 *   3. Explicit `doco_users` grants
 *
 * Mirrors the /users page logic (single source of truth for "what
 * Docos can this user see"). Use this for any UI that needs to
 * surface the user's full Doco set — including the OAuth approve
 * screen and the Device-Flow approve screen — instead of the bare
 * `listDocoIdsForUser`, which only sees source #3.
 */
export async function listAccessibleDocoIdsForPrincipal(principalId: string): Promise<string[]> {
  const ids = new Set<string>();
  await withClient(async (c) => {
    const direct = await c.query<{ id: string }>(
      "SELECT id FROM docos WHERE owner_id = $1 AND deleted_at IS NULL",
      [principalId],
    );
    for (const row of direct.rows) {
      ids.add(String(row.id));
    }
    const viaWorkspace = await c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT workspace_id FROM workspace_users WHERE user_id = $1
       ) AND deleted_at IS NULL`,
      [principalId],
    );
    for (const row of viaWorkspace.rows) {
      ids.add(String(row.id));
    }
  });
  const viaDocoUsers = await listDocoIdsForUser(principalId);
  for (const id of viaDocoUsers) {
    ids.add(id);
  }
  return Array.from(ids);
}

/**
 * The principal's accessible Docos, narrowed to a single workspace. Used by
 * the Slack integration: a Slack team is bound to one Doco workspace, so
 * Señor Doco may only reach the linked user's Docos INSIDE that workspace —
 * never their whole account. Always a subset of
 * `listAccessibleDocoIdsForPrincipal`; returns [] for an empty workspace id
 * (fail closed — an unbound team grants no personal access).
 */
export async function listAccessibleDocoIdsInWorkspace(
  principalId: string,
  workspaceId: string,
): Promise<string[]> {
  if (!workspaceId) return [];
  const all = await listAccessibleDocoIdsForPrincipal(principalId);
  if (all.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      "SELECT id FROM docos WHERE id = ANY($1::text[]) AND workspace_id = $2 AND deleted_at IS NULL",
      [all, workspaceId],
    );
    return r.rows.map((row) => String(row.id));
  });
}

export interface ReadableWorkspaceDoco {
  id: string;
  handle: string;
  visibility: "public" | "private";
  /** The template the Doco was created from: its type icon, and what it holds. */
  template: string | null;
}

/**
 * The Docos in one workspace that `principalId` may read: the public ones, plus
 * the ones they hold a grant on. Anything that lists a workspace's Docos to a
 * caller (the workspace home, workspace search) enumerates through this —
 * never `docos WHERE workspace_id` — so a workspace page never surfaces a Doco
 * the caller couldn't open directly.
 */
export async function listReadableDocosInWorkspace(
  workspaceId: string,
  principalId: string | null,
): Promise<ReadableWorkspaceDoco[]> {
  const granted = principalId
    ? await listAccessibleDocoIdsInWorkspace(principalId, workspaceId)
    : [];
  return withClient(async (c) => {
    const r = await c.query<ReadableWorkspaceDoco>(
      `SELECT id, handle, visibility, data->>'template_handle' AS template FROM docos
        WHERE workspace_id = $1 AND deleted_at IS NULL
          AND (visibility = 'public' OR id = ANY($2::text[]))
        ORDER BY handle`,
      [workspaceId, granted],
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      handle: String(row.handle),
      visibility: row.visibility,
      template: row.template,
    }));
  });
}

/**
 * Same as `canAccessDoco` but for write/admin operations — the
 * owner-tier gate. Per decision_01KS0JBJ5X0AZ4XJJFKEWE1R62, owner-tier
 * is the only role that can add users, delete the doco, or edit
 * policies. Writers can add/edit/retire nodes and edges but
 * cannot administer the doco; readers can read only.
 */
export async function canAdminDoco(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (await isHostBootstrapOwned(meta.ownerId)) return true;
  if (!principalId) return false;
  const role = await getDocoLevelRole(meta, principalId);
  return role === "owner";
}

/**
 * Admin gate that also enforces the Señor Doco ceiling: the agent never
 * administers a Doco — even an unclaimed host-bootstrap one — regardless of
 * the underlying human's role. Owner-gated admin routes (project tokens, and
 * settings via `loadDocoForAdmin`) call this instead of `canAdminDoco`.
 */
export async function canAdminDocoForRequest(
  request: Request,
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  // Admin is owner-tier: any request ceiling below owner (Señor Doco, or an
  // actor token approved below owner) can never administer the Doco.
  if ((await requestRoleCeiling(request)) !== null) return false;
  return canAdminDoco(meta, principalId);
}

/**
 * Writer-tier check — can add, edit, retire, or transition the
 * lifecycle of nodes and edges in this doco. The old reader /
 * author / approver / owner ladder collapsed to reader / writer /
 * owner: anyone with write may modify everything (subject only to the
 * Doco's own policies), so this is the gate for all content writes
 * and lifecycle moves.
 */
export async function canWriteDoco(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (!principalId) return false;
  const role = await getDocoLevelRole(meta, principalId);
  return roleAtLeast(role, "writer");
}

/**
 * Policy-edit gate. Policies accept edits only from doco-level
 * owners — a writer grant does not promote to policy editor.
 */
export async function canEditPolicies(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (await isHostBootstrapOwned(meta.ownerId)) return true;
  if (!principalId) return false;
  const role = await getDocoLevelRole(meta, principalId);
  return role === "owner";
}

/**
 * Standard 404 thrown when the caller asked for a Doco that doesn't
 * exist. Used only for the "no such handle" case — when the Doco
 * exists but the caller can't see it, `accessDeniedResponse` runs
 * instead so the UI can offer sign-in / invite-request prompts. The
 * mild existence leak that introduces (a non-member learns "yes, this
 * handle is real") is accepted in trade for the UX win; matches the
 * GitHub / Notion / Linear pattern.
 */
export function notFoundForAccessDenied(ownerSlug: string, docoSlug: string): Response {
  const label = docoSlug ? `${ownerSlug}/${docoSlug}` : ownerSlug;
  return new Response(`Doco "${label}" not found.`, { status: 404 });
}

/**
 * Structured 403 thrown when the Doco exists but the caller lacks
 * access. The ErrorBoundary in `root.tsx` recognizes the JSON shape
 * and renders an access-denied page (sign-in CTA when anonymous,
 * invite-request prose when signed in). API callers see the same
 * payload — clearer than the old 404 contract.
 */
export function accessDeniedResponse(
  handle: string,
  ownerSlug: string,
  signedIn: boolean,
): Response {
  const body = JSON.stringify({
    kind: "access_denied",
    error: `Access denied to Doco "${handle}".`,
    doco_handle: handle,
    owner_slug: ownerSlug,
    signed_in: signedIn,
  });
  return new Response(body, {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export interface DocoRouteParams {
  docoHandle?: string;
  docoId?: string;
}

export function readDocoRouteParam(params: DocoRouteParams): string | null {
  return params.docoHandle ?? params.docoId ?? null;
}

/**
 * Resolve a public Doco route param to the canonical record. Public
 * routes use `params.docoHandle`; id-addressed API routes can pass
 * `params.docoId`. The returned `ownerSlug` and `docoSlug` are
 * synthesized by `mapDocoRow`: `ownerSlug` comes from a JOIN to
 * `users.github_login` / `workspaces.handle`, and `docoSlug`
 * mirrors `handle`.
 */
export async function normalizeDocoParams(params: DocoRouteParams): Promise<{
  ownerSlug: string;
  docoSlug: string;
  handle: DocoHandle;
  docoHandle: DocoHandle;
  docoId: string;
}> {
  const routeParam = readDocoRouteParam(params);
  if (!routeParam) {
    throw notFoundForAccessDenied("", "");
  }
  const row = await getDocoByIdOrHandle(routeParam);
  if (!row) throw notFoundForAccessDenied(routeParam, "");
  const handle = row.handle as DocoHandle;
  return {
    ownerSlug: row.owner_slug,
    docoSlug: row.handle,
    handle,
    docoHandle: handle,
    docoId: row.id,
  };
}

/**
 * Load + privacy-gate a Doco for a read route. `minRole` (default
 * `reader`) is the minimum role the OAuth-token scope-down must
 * grant on this Doco for the request to pass — pass `"writer"` for
 * capture endpoints, `"owner"` for admin endpoints (or use
 * `loadDocoForAdmin`).
 */
export async function loadDocoForRead(
  request: Request,
  handleOrId: string,
  minRole: DocoRole = "reader",
): Promise<{
  dir: string;
  meta: DocoMetadata;
  me: CurrentPrincipal | null;
  canonicalOwnerSlug: string;
  canonicalDocoSlug: string;
  canonicalHandle: string;
}> {
  const row = await getDocoByIdOrHandle(handleOrId);
  if (!row) throw notFoundForAccessDenied(handleOrId, "");
  const dir = docoPath(row.handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) throw notFoundForAccessDenied(handleOrId, "");

  // Project-token short-circuit. A project token reads every Doco of one
  // workspace at reader role and carries no user identity, so the standard
  // "validate-bearer then check principal access" path does not apply.
  // Resolve and gate it here before falling through to the OAuth/cookie path.
  const projectTokenResult = await tryProjectTokenAccess(request, {
    workspaceId: row.workspace_id,
    minRole,
  });
  if (projectTokenResult.handled) {
    if (isAgentRead(request)) {
      waitUntil(recordQuery(request, { workspaceId: row.workspace_id, docoId: row.id }, null));
    }
    return {
      dir,
      meta,
      me: null,
      canonicalOwnerSlug: row.owner_slug,
      canonicalDocoSlug: row.handle,
      canonicalHandle: row.handle,
    };
  }

  // Bearer-token validation BEFORE the access check. If the caller
  // presented an OAuth-shaped bearer that's invalid (revoked / expired
  // / unknown), we want 401 + WWW-Authenticate per RFC 6750 §3, so the
  // runtime knows to refresh or restart the OAuth dance. Otherwise the
  // request would fall through to the anonymous-on-private-Doco branch
  // and get a generic 403, which doesn't tell the runtime anything
  // about why.
  await enforceOauthGrant(request, { docoId: row.id, ownerId: row.owner_id }, minRole);
  const me = await getCurrentPrincipalAsync(request);
  if (!(await canAccessDoco(meta, me?.id ?? null))) {
    throw accessDeniedResponse(row.handle, row.owner_slug, !!me);
  }
  if (isAgentRead(request)) {
    waitUntil(
      recordQuery(request, { workspaceId: row.workspace_id, docoId: row.id }, me?.id ?? null),
    );
  }
  return {
    dir,
    meta,
    me,
    canonicalOwnerSlug: row.owner_slug,
    canonicalDocoSlug: row.handle,
    canonicalHandle: row.handle,
  };
}

/**
 * Try to satisfy the request with a project token. Returns
 * `{ handled: true }` when the bearer was a project token AND it
 * granted the requested operation on this Doco — the caller can skip
 * the rest of the access check.
 *
 * Throws a 401/403 Response when the bearer was a project token but
 * the grant did not match (wrong Doco, revoked, or trying to write
 * with a reader-only token). That short-circuits with the right
 * RFC 6750 framing.
 *
 * Returns `{ handled: false }` when there is no project-token bearer
 * present — the caller falls through to OAuth + cookie logic.
 */
async function tryProjectTokenAccess(
  request: Request,
  args: { workspaceId: string; minRole: DocoRole },
): Promise<{ handled: boolean; token?: ProjectToken }> {
  const bearer = extractBearer(request);
  if (!bearer || !isProjectToken(bearer)) return { handled: false };

  const token = await validateProjectToken(bearer);
  if (!token) {
    throw new Response(
      JSON.stringify({
        kind: "invalid_token",
        error: "Project token is unknown or revoked.",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer error="invalid_token", error_description="The project token is unknown or revoked"`,
        },
      },
    );
  }
  if (token.workspace_id !== args.workspaceId) {
    throw new Response(
      JSON.stringify({
        kind: "access_denied",
        error: "Project token is scoped to a different workspace.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!roleAtLeast("reader", args.minRole)) {
    throw new Response(
      JSON.stringify({
        kind: "insufficient_scope",
        error: `Project token grants 'reader' on this Doco; this operation requires '${args.minRole}'. Use an OAuth token with the required role.`,
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer error="insufficient_scope", scope="doco"`,
        },
      },
    );
  }
  return { handled: true, token };
}

export type LoadedDocoRoute = Awaited<ReturnType<typeof normalizeDocoParams>> &
  Awaited<ReturnType<typeof loadDocoForRead>>;

function loadedDocoRouteFields(
  loaded: Awaited<ReturnType<typeof loadDocoForRead>>,
): Awaited<ReturnType<typeof normalizeDocoParams>> {
  const handle = loaded.canonicalHandle as DocoHandle;
  return {
    ownerSlug: loaded.canonicalOwnerSlug,
    docoSlug: loaded.canonicalDocoSlug,
    handle,
    docoHandle: handle,
    docoId: loaded.meta.docoId,
  };
}

export async function loadDocoRouteForRead(
  request: Request,
  params: DocoRouteParams,
  minRole: DocoRole = "reader",
): Promise<LoadedDocoRoute> {
  const routeParam = readDocoRouteParam(params);
  if (!routeParam) {
    throw notFoundForAccessDenied("", "");
  }
  const loaded = await loadDocoForRead(request, routeParam, minRole);
  const route = loadedDocoRouteFields(loaded);
  return { ...route, ...loaded };
}

export type LoadedPostCreateDocoRoute = LoadedDocoRoute & {
  createdDocoId: string | null;
};

export async function loadPostCreateDocoRouteForRead(
  request: Request,
  params: DocoRouteParams,
  minRole: DocoRole = "reader",
): Promise<LoadedPostCreateDocoRoute> {
  const createdDocoId = readCreatedDocoIdSearchParam(request);
  const routeParam = createdDocoId ?? readDocoRouteParam(params);
  if (!routeParam) {
    throw notFoundForAccessDenied("", "");
  }
  const loaded = await loadDocoForRead(request, routeParam, minRole);
  const route = loadedDocoRouteFields(loaded);
  return { ...route, ...loaded, createdDocoId };
}

export async function loadDocoRouteForAdmin(
  request: Request,
  params: DocoRouteParams,
): Promise<LoadedDocoRoute> {
  const routeParam = readDocoRouteParam(params);
  if (!routeParam) {
    throw notFoundForAccessDenied("", "");
  }
  const loaded = await loadDocoForAdmin(request, routeParam);
  const route = loadedDocoRouteFields(loaded);
  return { ...route, ...loaded };
}

/**
 * If the request is authenticated via an OAuth access token, the
 * token must grant access to this Doco — either:
 *   (a) `docoId` is in `granted_doco_ids` (with the per-Doco role
 *       at least `minRole`), OR
 *   (b) the Doco's `ownerId` is an workspace in `granted_workspace_ids`
 *       (with the per-workspace role at least `minRole`).
 *
 * Workspace grants are "live": they cover every Doco the workspace owns now AND
 * any Doco created under the workspace after the token was minted.
 *
 * No-op for cookie sessions or anonymous reads on public docos.
 *
 *   - No `Authorization` header → no-op; downstream anonymous /
 *     cookie logic handles the request.
 *   - Bearer that looks like an OAuth access token (`doco_at_…`) but
 *     fails validation (revoked, expired, or unknown) → 401 with
 *     `WWW-Authenticate: Bearer error="invalid_token"` per RFC 6750
 *     §3.1, so the runtime knows to refresh or re-auth.
 *   - Bearer that doesn't even look like an OAuth token → no-op;
 *     unrecognized credentials fall through to the route's normal
 *     anonymous/cookie path.
 *   - Valid bearer but neither doco nor workspace grant matches → 403.
 *   - Valid bearer with a matching grant but the role scope-down is
 *     below `minRole` (e.g. token grants reader, the route needs
 *     author) → 403 with `insufficient_scope`.
 */
async function enforceOauthGrant(
  request: Request,
  doco: { docoId: string; ownerId: string },
  minRole: DocoRole = "reader",
): Promise<void> {
  const bearer = extractBearer(request);
  if (!bearer) return;
  const looksOauth = bearer.startsWith("doco_at_");
  const token = await validateAccessToken(bearer);
  if (!token) {
    if (looksOauth) {
      throw new Response(
        JSON.stringify({
          kind: "invalid_token",
          error: "OAuth access token is invalid, revoked, or expired.",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer error="invalid_token", error_description="The access token is invalid, revoked, or expired"`,
          },
        },
      );
    }
    return;
  }

  // Actor token: no stored grants — it acts as its user. Authorize against the
  // human's LIVE role on this Doco, capped at actor_role. This is what lets one
  // app-wide `/mcp` connection reach every workspace the human belongs to,
  // while never exceeding the role they approved.
  if (token.grant_type === "actor") {
    const liveRole = capRole(
      await getDocoLevelRole({ ownerId: doco.ownerId, docoId: doco.docoId }, token.user_id),
      token.actor_role,
    );
    if (!liveRole || !roleAtLeast(liveRole, minRole)) {
      throw new Response(
        JSON.stringify({
          kind: liveRole ? "insufficient_scope" : "access_denied",
          error: liveRole
            ? `This 'all workspaces' token is capped at '${token.actor_role}', and this operation requires '${minRole}'.`
            : "You don't have access to this Doco.",
        }),
        {
          status: liveRole ? 403 : 403,
          headers: {
            "Content-Type": "application/json",
            ...(liveRole
              ? { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="doco"` }
              : {}),
          },
        },
      );
    }
    return;
  }

  const docoGranted = token.granted_doco_ids.includes(doco.docoId);
  const workspaceGranted =
    doco.ownerId.startsWith("workspace_") &&
    (token.granted_workspace_ids ?? []).includes(doco.ownerId);

  if (!docoGranted && !workspaceGranted) {
    throw new Response(
      JSON.stringify({
        kind: "access_denied",
        error: "OAuth token not authorized for this Doco. Re-authorize at /oauth/authorize.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // Role scope-down. A grant matches the request only if the granted
  // role (per-Doco or per-workspace, whichever applies) is ≥ minRole. If
  // both grants apply, the operation passes when EITHER meets the
  // threshold — the broader grant wins. Missing entry means "no
  // scope-down" for that path → inherits the principal's actual role,
  // which is enforced elsewhere.
  const docoRole = docoGranted
    ? (token.granted_doco_roles?.[doco.docoId] as DocoRole | undefined)
    : undefined;
  const workspaceRole = workspaceGranted
    ? (token.granted_workspace_roles?.[doco.ownerId] as DocoRole | undefined)
    : undefined;

  const docoMeets = docoGranted && (!docoRole || roleAtLeast(docoRole, minRole));
  const workspaceMeets =
    workspaceGranted && (!workspaceRole || roleAtLeast(workspaceRole, minRole));

  if (!docoMeets && !workspaceMeets) {
    const effective = docoRole ?? workspaceRole ?? "no role";
    throw new Response(
      JSON.stringify({
        kind: "insufficient_scope",
        error: `OAuth token grants '${effective}' on this Doco; this operation requires '${minRole}'. Re-authorize to widen the scope.`,
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer error="insufficient_scope", scope="doco"`,
        },
      },
    );
  }
}

/**
 * Same as `loadDocoForRead` but also requires admin rights.
 */
export async function loadDocoForAdmin(
  request: Request,
  handleOrId: string,
): Promise<{
  dir: string;
  meta: DocoMetadata;
  me: CurrentPrincipal | null;
  canonicalOwnerSlug: string;
  canonicalDocoSlug: string;
  canonicalHandle: string;
}> {
  // The OAuth-token role scope-down must grant at least "owner" on
  // this Doco — admin operations refuse a scoped-down token even if
  // the underlying principal is an admin.
  const ctx = await loadDocoForRead(request, handleOrId, "owner");
  // Señor Doco never administers a Doco — even on host-bootstrap (unclaimed)
  // Docos, where `canAdminDoco` would otherwise wave any caller through.
  if (isSenorDocoRequest(request) || !(await canAdminDoco(ctx.meta, ctx.me?.id ?? null))) {
    throw new Response("Forbidden: only the Doco's owner can edit this.", { status: 403 });
  }
  return ctx;
}
