// Privacy gate for docos. Postgres-backed
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import {
  type DocoRole,
  isOrgUser as dbIsOrgMember,
  getDocoByIdOrHandle,
  getDocoUserRole,
  getOrgRole,
  getPrincipalById,
  listDocoIdsForUserPrincipal,
  maxRole,
  roleAtLeast,
  withClient,
} from "@doco/db";
import type { DocoHandle } from "@doco/shared";
import { redirect } from "react-router";
import { docoPath } from "./db.server";
import { type DocoMetadata, readDocoMetadata } from "./doco-metadata.server";
import { validateAccessToken } from "./oauth-server.server";
import { resolvePrincipalUsernameAlias } from "./principal-aliases.server";
import { type CurrentPrincipal, extractBearer, getCurrentPrincipalAsync } from "./session";

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
 * directly. Invite redemptions write the doco_users row themselves;
 * OAuth tokens are only authentication, not membership storage.
 */
export async function listInvitedDocoIdsForPrincipal(principalId: string): Promise<Set<string>> {
  const ids = await listDocoIdsForUserPrincipal(principalId);
  return new Set(ids);
}

/**
 * Every Doco the principal can read or write — the union of three
 * sources:
 *   1. Docos they own directly (`docos.owner_id = principal_id`)
 *   2. Docos owned by an org they belong to (any role in `org_users`)
 *   3. Explicit `doco_users` grants
 *
 * Mirrors the /users page logic (single source of truth for "what
 * Docos can this user see"). Use this for any UI that needs to
 * surface the user's full Doco set — including the OAuth approve
 * screen and the Device-Flow approve screen — instead of the bare
 * `listDocoIdsForUserPrincipal`, which only sees source #3.
 */
export async function listAccessibleDocoIdsForPrincipal(principalId: string): Promise<string[]> {
  const ids = new Set<string>();
  await withClient(async (c) => {
    const direct = await c.query<{ id: string }>(`SELECT id FROM docos WHERE owner_id = $1`, [
      principalId,
    ]);
    direct.rows.forEach((r) => ids.add(String(r.id)));
    const viaOrg = await c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT org_id FROM org_users WHERE principal_id = $1
       )`,
      [principalId],
    );
    viaOrg.rows.forEach((r) => ids.add(String(r.id)));
  });
  const viaDocoUsers = await listDocoIdsForUserPrincipal(principalId);
  viaDocoUsers.forEach((id) => ids.add(id));
  return Array.from(ids);
}

/**
 * Same as `canAccessDoco` but for write/admin operations — the
 * owner-tier gate. Per decision_01KS0JBJ5X0AZ4XJJFKEWE1R62, owner-tier
 * is the only role that can add users, delete the doco, or edit
 * constitution articles. Approver-tier can approve lifecycle but cannot
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
 * Constitution-edit gate. Constitution articles accept edits only from
 * doco-level owners — author/approver grants do not promote to
 * constitution-editor.
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
  handle: DocoHandle;
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
    handle: row.handle as DocoHandle,
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
  await enforceOauthGrant(request, row.id, minRole);
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
 * token's `granted_doco_ids` must include `docoId` AND the token's
 * `granted_doco_roles[docoId]` (if specified) must be at least
 * `minRole`. No-op for cookie sessions or anonymous reads on public
 * docos.
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
 *   - Valid bearer but `docoId` isn't in `granted_doco_ids` → 403.
 *   - Valid bearer with this `docoId` granted but the per-Doco role
 *     scope-down is below `minRole` (e.g. token grants reader, the
 *     route needs author) → 403 with `insufficient_scope`.
 */
async function enforceOauthGrant(
  request: Request,
  docoId: string,
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
  if (!token.granted_doco_ids.includes(docoId)) {
    throw new Response(
      JSON.stringify({
        kind: "access_denied",
        error: "OAuth token not authorized for this Doco. Re-authorize at /oauth/authorize.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  // Per-Doco role scope-down: the granting user can have lowered the
  // token's effective role on this Doco below the operation's
  // requirement. Missing entry means "no scope-down" → inherits the
  // principal's actual role, which is enforced elsewhere.
  const grantedRole = token.granted_doco_roles?.[docoId];
  if (grantedRole && !roleAtLeast(grantedRole as DocoRole, minRole)) {
    throw new Response(
      JSON.stringify({
        kind: "insufficient_scope",
        error: `OAuth token grants '${grantedRole}' on this Doco; this operation requires '${minRole}'. Re-authorize to widen the scope.`,
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
