// Privacy gate for docos. Postgres-backed
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import { redirect } from "react-router";
import {
  getDocoByIdOrHandle,
  getPrincipalById,
  isOrgAdmin as dbIsOrgAdmin,
  isOrgMember as dbIsOrgMember,
} from "@doco/db";
import { docoPath, rootDir } from "./db.server";
import { TokenStore } from "./tokens.server";
import { resolvePrincipalUsernameAlias } from "./principal-aliases.server";
import { type DocoMetadata, readDocoMetadata } from "./scope-helpers.server";
import { type CurrentPrincipal, getCurrentPrincipalAsync } from "./session";

/**
 * Can `principalId` read this Doco?
 *
 *   - public visibility → always yes (anonymous OK).
 *   - host-bootstrap-owned (unclaimed) → always yes regardless of visibility.
 *   - private visibility:
 *       - unauthenticated → no.
 *       - principalId === ownerId → yes.
 *       - principalId is an agent whose `owner_id` === ownerId → yes.
 *       - ownerId is an Organization → yes iff principalId (or its
 *         owning Principal, for agents) is a member.
 *       - otherwise → no.
 */
export async function canAccessDoco(
  meta: { ownerId: string; visibility: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (meta.visibility === "public") return true;
  if (await isHostBootstrapOwned(meta.ownerId)) return true;
  if (!principalId) return false;
  if (meta.ownerId === principalId) return true;

  const ownerOfPrincipal = await getPrincipalOwnerId(principalId);
  if (ownerOfPrincipal && ownerOfPrincipal === meta.ownerId) return true;

  if (meta.ownerId.startsWith("organization_")) {
    if (await dbIsOrgMember(meta.ownerId, principalId)) return true;
    if (ownerOfPrincipal && (await dbIsOrgMember(meta.ownerId, ownerOfPrincipal))) return true;
  }

  // Invited collaborator: holds an active SessionToken bound to this
  // Doco. Same source of truth the dashboard uses to list it.
  if (meta.docoId) {
    const invited = await listInvitedDocoIdsForPrincipal(principalId);
    if (invited.has(meta.docoId)) return true;
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
 * Doco ids the principal holds an active, invite-redeemed SessionToken
 * for. Source of truth for "invited collaborator" status — the human
 * invite flow at /invite/<code> binds the existing human Principal to
 * the Doco purely by minting a SessionToken with bound_doco_id; there
 * is no separate collaborators table.
 */
export async function listInvitedDocoIdsForPrincipal(
  principalId: string,
): Promise<Set<string>> {
  const file = await TokenStore.forDoco(rootDir()).load();
  const ids = new Set<string>();
  for (const t of file.tokens) {
    if (t.kind !== "session") continue;
    if (t.revoked) continue;
    if (t.principal_id !== principalId) continue;
    if (t.bound_doco_id) ids.add(t.bound_doco_id);
  }
  return ids;
}

/**
 * Same as `canAccessDoco` but for write/admin operations. During alpha,
 * a Doco can have many owners — every invite-redeemed collaborator has
 * full admin rights. Reader/author tiers are deferred until we have a
 * real need to distinguish them.
 */
export async function canAdminDoco(
  meta: { ownerId: string; docoId?: string },
  principalId: string | null,
): Promise<boolean> {
  if (await isHostBootstrapOwned(meta.ownerId)) return true;
  if (!principalId) return false;
  if (meta.ownerId === principalId) return true;

  const ownerOfPrincipal = await getPrincipalOwnerId(principalId);
  if (ownerOfPrincipal && ownerOfPrincipal === meta.ownerId) return true;

  if (meta.ownerId.startsWith("organization_")) {
    if (await dbIsOrgAdmin(meta.ownerId, principalId)) return true;
    if (ownerOfPrincipal && (await dbIsOrgAdmin(meta.ownerId, ownerOfPrincipal))) return true;
  }

  if (meta.docoId) {
    const invited = await listInvitedDocoIdsForPrincipal(principalId);
    if (invited.has(meta.docoId)) return true;
  }
  return false;
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
