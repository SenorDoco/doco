// Privacy gate for docos. Postgres-backed
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import {
  type DocoRole,
  isOrgUser as dbIsOrgMember,
  getCollaboratorById,
  getDocoByIdOrHandle,
  getDocoUserRole,
  getOrgRole,
  getPrincipalById,
  listDocoIdsForCollaborator,
  maxRole,
  roleAtLeast,
  withClient,
} from "@doco/db";
import type { DocoHandle } from "@doco/shared";
import { redirect } from "react-router";
import { docoPath } from "./db.server";
import { type DocoMetadata, readDocoMetadata } from "./doco-metadata.server";
import { type ValidAccessToken, validateAccessToken } from "./oauth-server.server";
import { readCreatedDocoIdSearchParam } from "./post-create-doco-route";
import { type ProjectToken, isProjectToken, validateProjectToken } from "./project-tokens.server";
import { type CurrentPrincipal, extractBearer, getCurrentPrincipalAsync } from "./session.server";

/**
 * Doco-level role for this principal — max of (direct owner_id match,
 * agent-owner-chain match, org-membership role on the owning org,
 * explicit doco_users row).
 *
 * Returns null when the principal has no doco-level grant.
 */
export async function getDocoLevelRole(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<DocoRole | null> {
  if (!principalId) return null;

  let role: DocoRole | null = null;
  const ownerOfPrincipal = await getPrincipalOwnerId(principalId);

  if (meta.ownerId === principalId) role = maxRole(role, "owner");
  if (ownerOfPrincipal && ownerOfPrincipal === meta.ownerId) {
    role = maxRole(role, "owner");
  }

  if (meta.ownerId.startsWith("organization_")) {
    const direct = await getOrgRole(meta.ownerId, principalId);
    role = maxRole(role, direct);
    if (ownerOfPrincipal) {
      const viaOwner = await getOrgRole(meta.ownerId, ownerOfPrincipal);
      role = maxRole(role, viaOwner);
    }
  }

  if (meta.docoId) {
    const dm = await getDocoUserRole(meta.docoId, principalId);
    role = maxRole(role, dm);
    if (ownerOfPrincipal) {
      const ownerDm = await getDocoUserRole(meta.docoId, ownerOfPrincipal);
      role = maxRole(role, ownerDm);
    }
  }

  return role;
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

/** True if the OAuth token's grants cover this Doco (per-Doco or per-org). */
export function oauthTokenGrantsDoco(
  token: ValidAccessToken,
  meta: { ownerId: string; docoId: string },
): boolean {
  if (token.granted_doco_ids.includes(meta.docoId)) return true;
  if (
    meta.ownerId.startsWith("organization_") &&
    (token.granted_org_ids ?? []).includes(meta.ownerId)
  ) {
    return true;
  }
  return false;
}

/**
 * Read-access predicate for API endpoints that don't already go through
 * `loadDocoForRead`. Layers OAuth-token scope-down on top of the
 * principal-level `canAccessDoco`:
 *
 *   - No bearer (cookie or anonymous): falls back to `canAccessDoco`.
 *   - Valid bearer that grants this Doco (per-Doco or per-org): falls
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

/** Read the owner_id field for either a collaborator identity or Principal neuron. */
async function getPrincipalOwnerId(principalId: string): Promise<string | null> {
  if (principalId.startsWith("collaborator_")) {
    const c = await getCollaboratorById(principalId);
    const ownerId = c?.data.owner_id;
    if (typeof ownerId !== "string") return null;
    if (!ownerId.startsWith("collaborator_") && !ownerId.startsWith("organization_")) {
      return null;
    }
    return ownerId;
  }
  if (!principalId.startsWith("principal_")) return null;
  const p = await getPrincipalById(principalId);
  if (!p) return null;
  const ownerId = p.data.owner_id;
  if (typeof ownerId !== "string") return null;
  if (
    !ownerId.startsWith("principal_") &&
    !ownerId.startsWith("collaborator_") &&
    !ownerId.startsWith("organization_")
  ) {
    return null;
  }
  return ownerId;
}

/**
 * "Is this Doco mine?" — predicate for the signed-in user's personal
 * dashboard. Stricter than `canAccessDoco`: ignores `public` visibility
 * and the host-bootstrap exemption. True iff the principal has a
 * personal stake in the Doco: they own it, they're an agent of the
 * owner, or they're a member of the owning organization. Invite-
 * redeemed collaborators are handled separately via
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

  if (meta.ownerId.startsWith("organization_")) {
    if (await dbIsOrgMember(meta.ownerId, principalId)) return true;
    if (ownerOfPrincipal && (await dbIsOrgMember(meta.ownerId, ownerOfPrincipal))) return true;
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
  const ids = await listDocoIdsForCollaborator(principalId);
  return new Set(ids);
}

/**
 * Every Doco the principal can read or write — the union of three
 * sources:
 *   1. Docos they own directly (`docos.owner_id = collaborator_id`)
 *   2. Docos owned by an org they belong to (any role in `org_users`)
 *   3. Explicit `doco_users` grants
 *
 * Mirrors the /collaborators page logic (single source of truth for "what
 * Docos can this user see"). Use this for any UI that needs to
 * surface the user's full Doco set — including the OAuth approve
 * screen and the Device-Flow approve screen — instead of the bare
 * `listDocoIdsForCollaborator`, which only sees source #3.
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
    const viaOrg = await c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT org_id FROM org_users WHERE collaborator_id = $1
       )`,
      [principalId],
    );
    for (const row of viaOrg.rows) {
      ids.add(String(row.id));
    }
  });
  const viaDocoUsers = await listDocoIdsForCollaborator(principalId);
  for (const id of viaDocoUsers) {
    ids.add(id);
  }
  return Array.from(ids);
}

/**
 * Same as `canAccessDoco` but for write/admin operations — the
 * owner-tier gate. Per decision_01KS0JBJ5X0AZ4XJJFKEWE1R62, owner-tier
 * is the only role that can add users, delete the doco, or edit
 * policies. Approver-tier can approve lifecycle but cannot
 * administer the doco; lower tiers can author or read only.
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

/** Approver-tier check — can flip lifecycle on authored nodes in this doco. */
export async function canApproveDoco(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (!principalId) return false;
  const role = await getDocoLevelRole(meta, principalId);
  return roleAtLeast(role, "approver");
}

/**
 * Policy-edit gate. Policies accept edits only from doco-level
 * owners — author/approver grants do not promote to policy editor.
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
 * Resolve a public Doco route param to the canonical record. Current
 * routes use `params.docoHandle`; `params.docoId` remains accepted for
 * legacy callers and id-based APIs. The returned `ownerSlug` and
 * `docoSlug` are back-compat fields synthesized by `mapDocoRow`:
 * `ownerSlug` comes from a JOIN to `collaborators.github_login` /
 * `organizations.handle`, `docoSlug` mirrors `handle`. Handlers that
 * need the legacy slug pair for internal plumbing (docoPath, captures)
 * keep destructuring them; new code should read `handle` directly.
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
 * grant on this Doco for the request to pass — pass `"author"` for
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
  // at reader role, and do not carry a collaborator identity — so the
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
 *   (b) the Doco's `ownerId` is an organization in `granted_org_ids`
 *       (with the per-org role at least `minRole`).
 *
 * Org grants are "live": they cover every Doco the org owns now AND
 * any Doco created under the org after the token was minted.
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
 *   - Valid bearer but neither doco nor org grant matches → 403.
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

  const docoGranted = token.granted_doco_ids.includes(doco.docoId);
  const orgGranted =
    doco.ownerId.startsWith("organization_") &&
    (token.granted_org_ids ?? []).includes(doco.ownerId);

  if (!docoGranted && !orgGranted) {
    throw new Response(
      JSON.stringify({
        kind: "access_denied",
        error: "OAuth token not authorized for this Doco. Re-authorize at /oauth/authorize.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // Role scope-down. A grant matches the request only if the granted
  // role (per-Doco or per-org, whichever applies) is ≥ minRole. If
  // both grants apply, the operation passes when EITHER meets the
  // threshold — the broader grant wins. Missing entry means "no
  // scope-down" for that path → inherits the principal's actual role,
  // which is enforced elsewhere.
  const docoRole = docoGranted
    ? (token.granted_doco_roles?.[doco.docoId] as DocoRole | undefined)
    : undefined;
  const orgRole = orgGranted
    ? (token.granted_org_roles?.[doco.ownerId] as DocoRole | undefined)
    : undefined;

  const docoMeets = docoGranted && (!docoRole || roleAtLeast(docoRole, minRole));
  const orgMeets = orgGranted && (!orgRole || roleAtLeast(orgRole, minRole));

  if (!docoMeets && !orgMeets) {
    const effective = docoRole ?? orgRole ?? "no role";
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
