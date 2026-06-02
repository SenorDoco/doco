// Privacy gate for docos. Postgres-backed.

import {
  type DocoRole,
  isWorkspaceUser as dbIsWorkspaceMember,
  getAccountGrant,
  getDocoByIdOrHandle,
  getDocoUserGrant,
  getDocoUserRole,
  getPrincipalById,
  getWorkspaceGrant,
  getWorkspaceRole,
  listDocoIdsForUser,
  listWorkspaceOwnerUserIds,
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
import { redirect } from "react-router";
import { docoPath } from "./db.server";
import { type DocoMetadata, readDocoMetadata } from "./doco-metadata.server";
import { type ValidAccessToken, validateAccessToken } from "./oauth-server.server";
import { readCreatedDocoIdSearchParam } from "./post-create-doco-route";
import { type ProjectToken, isProjectToken, validateProjectToken } from "./project-tokens.server";
import { type CurrentPrincipal, extractBearer, getCurrentPrincipalAsync } from "./session.server";

/**
 * Doco-level role for this principal — max of (direct owner_id match,
 * workspace-membership role on the owning workspace, account grants, explicit
 * doco_users row).
 *
 * Returns null when the principal has no doco-level grant.
 */
export async function getDocoLevelRole(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<DocoRole | null> {
  // Delegate to getDocoLevelGrant so the role and per-type-write paths
  // resolve access from exactly the same sources (direct owner, workspace
  // membership, account grants, doco membership) — there is no second
  // copy of the source list to drift out of sync.
  const grant = await getDocoLevelGrant(meta, principalId);
  return grant?.role ?? null;
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
    // Account-level grants: if any OWNER of this workspace has granted their
    // whole account to the principal, the principal inherits that grant
    // on every workspace/doco that owner owns — including this one.
    const workspaceOwners = await listWorkspaceOwnerUserIds(meta.ownerId);
    for (const grantor of workspaceOwners) {
      fold(await getAccountGrant(grantor, principalId));
    }
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
 * Policy types (guidance_policy, node_authoring_policy) are NOT
 * write-gateable content — they configure the Doco and stay owner-only,
 * matching `canEditPolicies`. Any non-writable type therefore requires
 * the owner role.
 *
 * This does NOT enforce the OAuth-token scope-down; for bearer-auth API
 * routes the caller still routes through the token gate
 * (`enforceOauthGrant`) which now also narrows per type.
 */
/**
 * A "*" in granted_doco_ids marks a defer-scope (identity / "Full access")
 * token: it may touch ANY Doco the principal can reach, with role + per-type
 * writes gated by the LIVE matrix grant (canAccessDoco / canWriteDocoType),
 * never a frozen scope list. Effective access stays min(matrix, *) = the
 * principal's live access, so a new grant (a new Doco, or reader→writer)
 * applies on the next call with no re-auth.
 */
function tokenDefersScope(token: { granted_doco_ids?: readonly string[] | null }): boolean {
  return (token.granted_doco_ids ?? []).includes("*");
}

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

  if (tokenDefersScope(token)) {
    matched = true;
    addTokenWriteCap(caps, undefined, token.granted_doco_write_types?.["*"] ?? [WRITE_ALL]);
  }
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
  // Policy types are owner-only and not token-scopeable per type; the
  // membership check above already required owner, so allow.
  if (!isWritableType(type)) return true;

  const token = await getOauthTokenForRequest(request);
  const cap = tokenWriteTypeCap(token, meta);
  if (cap === null) return true; // cookie session: no token scope-down
  return canWriteType("reader", cap, type as WritableType);
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
  if (tokenDefersScope(token)) return true;
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
      "SELECT id, owner_id FROM docos WHERE id = ANY($1::text[])",
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
  // Defer-scope tokens enumerate everything the principal can reach.
  if (tokenDefersScope(token)) return [...accessibleDocoIds];
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
 * principal set unchanged — the dashboard and OAuth approve screen want
 * everything the human can reach. A bearer-token request is narrowed to
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
  if (!token || accessible.length === 0) return accessible;
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
  if (!token) return null;
  // Defer-scope tokens reach every workspace the principal does — no narrowing.
  if (tokenDefersScope(token)) return null;
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
  return p?.name === "host-bootstrap";
}

/** Read the owner_id field for either a user identity or Principal node. */
async function getPrincipalOwnerId(principalId: string): Promise<string | null> {
  if (!principalId.startsWith("principal_")) return null;
  const p = await getPrincipalById(principalId);
  if (!p) return null;
  const ownerId = p.data.owner_id;
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
 * "Is this Doco mine?" — predicate for the signed-in user's personal
 * dashboard. Stricter than `canAccessDoco`: ignores `public` visibility
 * and the host-bootstrap exemption. True iff the principal has a
 * personal stake in the Doco: they own it, or they're a member of the
 * owning workspace. Invite-redeemed users are handled separately via
 * `listInvitedDocoIdsForPrincipal` — that path needs the Doco id, not
 * the owner id, so callers union the two sets.
 */
export async function isMyDoco(
  meta: { ownerId: string },
  principalId: string | null,
): Promise<boolean> {
  if (!principalId) return false;
  if (meta.ownerId === principalId) return true;

  const ownerOfPrincipal = await getPrincipalOwnerId(principalId);
  if (ownerOfPrincipal && ownerOfPrincipal === meta.ownerId) return true;

  if (meta.ownerId.startsWith("workspace_")) {
    if (await dbIsWorkspaceMember(meta.ownerId, principalId)) return true;
  }
  return false;
}

/**
 * Doco ids the principal has an explicit doco_users grant on (any role).
 * Source of truth for "I have a relationship with this doco" — the
 * dashboard's "shared with me" listing.
 *
 * Post-decision_01KS0JBJ5X0AZ4XJJFKEWE1R62, this reads from `doco_users`
 * directly. Invite redemptions write the doco_users row themselves;
 * OAuth tokens are only authentication, not membership storage.
 */
export async function listInvitedDocoIdsForPrincipal(principalId: string): Promise<Set<string>> {
  const ids = await listDocoIdsForUser(principalId);
  return new Set(ids);
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
    const direct = await c.query<{ id: string }>("SELECT id FROM docos WHERE owner_id = $1", [
      principalId,
    ]);
    for (const row of direct.rows) {
      ids.add(String(row.id));
    }
    const viaWorkspace = await c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT workspace_id FROM workspace_users WHERE user_id = $1
       )`,
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

  // Project-token short-circuit. Project tokens are Doco-scoped, fixed
  // at reader role, and do not carry a user identity — so the
  // standard "validate-bearer then check principal access" path does
  // not apply. Resolve and gate them here before falling through to
  // the OAuth/cookie path.
  const projectTokenResult = await tryProjectTokenAccess(request, {
    docoId: row.id,
    minRole,
  });
  if (projectTokenResult.handled) {
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
  args: { docoId: string; minRole: DocoRole },
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
  if (token.doco_id !== args.docoId) {
    throw new Response(
      JSON.stringify({
        kind: "access_denied",
        error: "Project token is scoped to a different Doco.",
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

export async function loadPostCreateDocoRouteForAdmin(
  request: Request,
  params: DocoRouteParams,
): Promise<LoadedPostCreateDocoRoute> {
  const createdDocoId = readCreatedDocoIdSearchParam(request);
  const routeParam = createdDocoId ?? readDocoRouteParam(params);
  if (!routeParam) {
    throw notFoundForAccessDenied("", "");
  }
  const loaded = await loadDocoForAdmin(request, routeParam);
  const route = loadedDocoRouteFields(loaded);
  return { ...route, ...loaded, createdDocoId };
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

  const docoGranted = tokenDefersScope(token) || token.granted_doco_ids.includes(doco.docoId);
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
  if (!(await canAdminDoco(ctx.meta, ctx.me?.id ?? null))) {
    throw new Response("Forbidden: only the Doco's owner can edit this.", { status: 403 });
  }
  return ctx;
}
