// Privacy gate for docos. Postgres-backed
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import {
  type DocoRole,
  isOrgUser as dbIsOrgMember,
  getDocoByIdOrHandle,
  getDocoUserRole,
  getOrgRole,
  getPrincipalById,
  getScopeUserRole,
  listDocoIdsForUserPrincipal,
  listScopeIdsWithGrant,
  maxRole,
  roleAtLeast,
} from "@doco/db";
import { redirect } from "react-router";
import { docoPath } from "./db.server";
import { validateAccessToken } from "./oauth-server.server";
import { resolvePrincipalUsernameAlias } from "./principal-aliases.server";
import { type DocoMetadata, readDocoMetadata } from "./scope-helpers.server";
import { type CurrentPrincipal, extractBearer, getCurrentPrincipalAsync } from "./session";

/**
 * Doco-level role for this principal — max of (direct owner_id match,
 * agent-owner-chain match, org-membership role on the owning org,
 * explicit doco_users row). Scope-level grants do NOT factor in here;
 * use `getEffectiveScopeRole` when you need the per-scope answer.
 *
 * Returns null when the principal has no doco-level grant.
 * (They may still have a scope-only grant — see `canAccessDoco`.)
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
 * Effective role when the principal operates ON a specific scope:
 *   max(doco-level role, scope_users grant for this scope)
 * Used by capture / lifecycle gates to decide whether to force lifecycle
 * to `proposed` (author) or honor the body's `lifecycle` (approver+).
 */
export async function getEffectiveScopeRole(
  meta: { ownerId: string; docoId?: string },
  scopeId: string,
  principalId: string | null,
): Promise<DocoRole | null> {
  if (!principalId) return null;

  let role = await getDocoLevelRole(meta, principalId);
  const direct = await getScopeUserRole(scopeId, principalId);
  role = maxRole(role, direct);

  const ownerOfPrincipal = await getPrincipalOwnerId(principalId);
  if (ownerOfPrincipal) {
    const viaOwner = await getScopeUserRole(scopeId, ownerOfPrincipal);
    role = maxRole(role, viaOwner);
  }

  return role;
}

/**
 * Can `principalId` read this Doco?
 *
 *   - public visibility → always yes (anonymous OK).
 *   - host-bootstrap-owned (unclaimed) → always yes regardless of visibility.
 *   - private visibility: any doco-level grant OR any scope-only grant on a
 *     scope inside this doco → yes (scope-only implies doco-reader per
 *     decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
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

  if (meta.docoId) {
    const scopes = await listScopeIdsWithGrant(meta.docoId, principalId);
    if (scopes.length > 0) return true;
  }
  return false;
}

/** True if ownerId is the host-bootstrap placeholder Principal (unclaimed docos). */
async function isHostBootstrapOwned(ownerId: string): Promise<boolean> {
  if (!ownerId.startsWith("principal_")) return false;
  const p = await getPrincipalById(ownerId);
  return p?.username === "host-bootstrap";
}

/** Read the `owner_id` field of a Principal record. */
async function getPrincipalOwnerId(principalId: string): Promise<string | null> {
  if (!principalId.startsWith("principal_")) return null;
  const p = await getPrincipalById(principalId);
  if (!p) return null;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(p.raw_yaml) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ownerId = raw.owner_id;
  if (typeof ownerId !== "string") return null;
  if (!ownerId.startsWith("principal_") && !ownerId.startsWith("organization_")) {
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
 * directly. The v8 backfill grandfathers existing SessionToken-bound
 * principals into doco_users with role='owner' so the answer is
 * unchanged for prior collaborators; new invite redemptions write the
 * doco_users row alongside the SessionToken.
 */
export async function listInvitedDocoIdsForPrincipal(principalId: string): Promise<Set<string>> {
  const ids = await listDocoIdsForUserPrincipal(principalId);
  return new Set(ids);
}

/**
 * Same as `canAccessDoco` but for write/admin operations — the
 * owner-tier gate. Per decision_01KS0JBJ5X0AZ4XJJFKEWE1R62, owner-tier
 * is the only role that can add users, delete the doco, manage scopes,
 * or edit #global Rules. Approver-tier can approve lifecycle but cannot
 * administer the doco; lower tiers can author or read only.
 *
 * Scope-level grants do NOT elevate to admin — even a scope-level owner
 * grant only governs that scope, not the doco as a whole.
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

/** Approver-tier check — can flip lifecycle on any scope in this doco. */
export async function canApproveDoco(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (!principalId) return false;
  const role = await getDocoLevelRole(meta, principalId);
  return roleAtLeast(role, "approver");
}

/**
 * Can the principal write a node INTO this scope? Author-tier minimum.
 * Their writes may still be forced to `lifecycle: proposed` if they're
 * exactly `author` — that gate lives in the capture layer.
 */
export async function canWriteScope(
  meta: { ownerId: string; docoId?: string },
  scopeId: string,
  principalId: string | null,
): Promise<boolean> {
  if (!principalId) return false;
  const role = await getEffectiveScopeRole(meta, scopeId, principalId);
  return roleAtLeast(role, "author");
}

/** Can the principal flip lifecycle on a node IN this scope? Approver-tier. */
export async function canApproveScope(
  meta: { ownerId: string; docoId?: string },
  scopeId: string,
  principalId: string | null,
): Promise<boolean> {
  if (!principalId) return false;
  const role = await getEffectiveScopeRole(meta, scopeId, principalId);
  return roleAtLeast(role, "approver");
}

/**
 * Constitution-edit gate. The #global scope (Constitution) accepts edits
 * only from doco-level owners — scope-level elevation does NOT promote
 * approver/author to constitution-editor. Per the Rule born_from
 * decision_01KS0JBJ5X0AZ4XJJFKEWE1R62.
 */
export async function canEditConstitution(
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

/**
 * Resolve `:docoId/*` route params to the canonical record. Accepts
 * the URL's single `params.docoId` segment, which may be a
 * human-readable handle (canonical) or a ULID. Throws a 404 if
 * nothing resolves. The returned `ownerSlug` and `docoSlug` are
 * back-compat fields synthesized by `mapDocoRow`: `ownerSlug` comes
 * from a JOIN to `principals.username` / `organizations.slug`,
 * `docoSlug` mirrors `handle`. Handlers that need the legacy slug
 * pair for internal plumbing (docoPath, captures) keep destructuring
 * them; new code should read `handle` directly.
 */
export async function normalizeDocoParams(params: {
  docoId?: string;
}): Promise<{
  ownerSlug: string;
  docoSlug: string;
  handle: string;
  docoId: string;
}> {
  if (!params.docoId) {
    throw notFoundForAccessDenied("", "");
  }
  const row = await getDocoByIdOrHandle(params.docoId);
  if (!row) throw notFoundForAccessDenied(params.docoId, "");
  return {
    ownerSlug: row.owner_slug,
    docoSlug: row.handle,
    handle: row.handle,
    docoId: row.id,
  };
}

/**
 * Load + privacy-gate a Doco for a read route.
 */
export async function loadDocoForRead(
  request: Request,
  handleOrId: string,
): Promise<{
  dir: string;
  meta: DocoMetadata;
  me: CurrentPrincipal | null;
  canonicalOwnerSlug: string;
  canonicalDocoSlug: string;
  canonicalHandle: string;
  redirected: boolean;
}> {
  const row = await getDocoByIdOrHandle(handleOrId);
  if (!row) throw notFoundForAccessDenied(handleOrId, "");
  // Principal-username alias compat (e.g., username renames). Drives a
  // 308 from the old handle to the canonical one when the JOINed
  // owner_slug indicates the principal has been renamed since the
  // handle was originally minted. Rare in practice.
  const ownerResolved = resolvePrincipalUsernameAlias(row.owner_slug);
  if (ownerResolved.redirected && handleOrId !== row.handle) {
    const url = new URL(request.url);
    const oldPrefix = `/${handleOrId}`;
    if (url.pathname === oldPrefix || url.pathname.startsWith(`${oldPrefix}/`)) {
      const newPath = `/${row.handle}${url.pathname.slice(oldPrefix.length)}`;
      throw new Response(null, {
        status: 308,
        headers: { Location: newPath + url.search },
      });
    }
  }
  const dir = docoPath(row.handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) throw notFoundForAccessDenied(handleOrId, "");
  // Bearer-token validation BEFORE the access check. If the caller
  // presented an OAuth-shaped bearer that's invalid (revoked / expired
  // / unknown), we want 401 + WWW-Authenticate per RFC 6750 §3, so the
  // runtime knows to refresh or restart the OAuth dance. Otherwise the
  // request would fall through to the anonymous-on-private-Doco branch
  // and get a generic 403, which doesn't tell the runtime anything
  // about why.
  await enforceOauthGrant(request, row.id);
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
    redirected: ownerResolved.redirected,
  };
}

/**
 * If the request is authenticated via an OAuth access token, the
 * token's `granted_doco_ids` must include `docoId`. No-op for cookie
 * sessions or anonymous reads on public docos.
 *
 *   - No `Authorization` header → no-op; downstream anonymous /
 *     cookie logic handles the request.
 *   - Bearer that looks like an OAuth access token (`doco_at_…`) but
 *     fails validation (revoked, expired, or unknown) → 401 with
 *     `WWW-Authenticate: Bearer error="invalid_token"` per RFC 6750
 *     §3.1, so the runtime knows to refresh or re-auth.
 *   - Bearer that doesn't even look like an OAuth token → no-op;
 *     unrecognized credentials fall through to the route's normal
 *     anonymous/cookie path (and likely 403 later if the Doco is
 *     private), which matches pre-OAuth behavior.
 *   - Valid bearer but `docoId` isn't in `granted_doco_ids` → 403.
 */
async function enforceOauthGrant(request: Request, docoId: string): Promise<void> {
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
            // RFC 6750 §3 / RFC 9728: tell the client this was a bearer
            // failure so it knows to refresh or restart the OAuth dance.
            "WWW-Authenticate": `Bearer error="invalid_token", error_description="The access token is invalid, revoked, or expired"`,
          },
        },
      );
    }
    return;
  }
  if (!token.granted_doco_ids.includes(docoId)) {
    throw new Response(
      JSON.stringify({
        kind: "access_denied",
        error: "OAuth token not authorized for this Doco. Re-authorize at /oauth/authorize.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
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
  const ctx = await loadDocoForRead(request, handleOrId);
  if (!(await canAdminDoco(ctx.meta, ctx.me?.id ?? null))) {
    throw new Response("Forbidden: only the Doco's owner can edit this.", { status: 403 });
  }
  return ctx;
}
