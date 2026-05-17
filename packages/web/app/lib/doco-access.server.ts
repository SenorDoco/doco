// Privacy gate for docos. Postgres-backed
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import { redirect } from "react-router";
import {
  getPrincipalById,
  isOrgAdmin as dbIsOrgAdmin,
  isOrgMember as dbIsOrgMember,
} from "@doco/db";
import { docoPath, rootDir } from "./db.server";
import { TokenStore } from "./tokens.server";
import { resolveDocoSlugAlias } from "./doco-aliases.server";
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
 * Standard 404 thrown by route loaders when the caller can't access the
 * Doco. Throws 404 instead of 403 so the existence of a private Doco
 * isn't leaked to non-members.
 */
export function notFoundForAccessDenied(ownerSlug: string, docoSlug: string): Response {
  return new Response(`Doco "${ownerSlug}/${docoSlug}" not found.`, { status: 404 });
}

/**
 * Load + privacy-gate a Doco for a read route.
 */
export async function loadDocoForRead(
  request: Request,
  ownerSlug: string,
  docoSlug: string,
): Promise<{
  dir: string;
  meta: DocoMetadata;
  me: CurrentPrincipal | null;
  canonicalOwnerSlug: string;
  canonicalDocoSlug: string;
  redirected: boolean;
}> {
  const ownerResolved = resolvePrincipalUsernameAlias(ownerSlug);
  let aliasResolved = await resolveDocoSlugAlias(ownerResolved.canonical, docoSlug);
  if (!aliasResolved) {
    // Phase 2 of slug-removal: if (owner, slug) doesn't resolve, try
    // the new shape — owner segment is actually a Doco `handle`, slug
    // segment is the first piece of the rest path. When that matches,
    // 308 to the canonical /<owner>/<slug>/<docoSlug> URL so existing
    // handlers keep serving it.
    const { getDocoByHandle } = await import("@doco/db");
    const byHandle = await getDocoByHandle(ownerSlug);
    if (byHandle) {
      const url = new URL(request.url);
      const oldPrefix = `/${ownerSlug}`;
      const rest = url.pathname.startsWith(`${oldPrefix}/`)
        ? url.pathname.slice(oldPrefix.length)
        : "";
      const newPath = `/${byHandle.owner_slug}/${byHandle.doco_slug}${rest}`;
      throw new Response(null, {
        status: 308,
        headers: { Location: newPath + url.search },
      });
    }
    throw notFoundForAccessDenied(ownerSlug, docoSlug);
  }
  // If either segment was non-canonical (alias followed), 308 to the
  // canonical URL. GitHub-style: old URLs keep working, clients learn
  // the canonical on the next round-trip. 308 preserves method so
  // POST/PATCH captures retry cleanly at the new URL.
  if (ownerResolved.redirected || aliasResolved.redirected) {
    const url = new URL(request.url);
    const oldPrefix = `/${ownerSlug}/${docoSlug}`;
    if (url.pathname === oldPrefix || url.pathname.startsWith(`${oldPrefix}/`)) {
      const newPath = `/${aliasResolved.ownerSlug}/${aliasResolved.docoSlug}${url.pathname.slice(
        oldPrefix.length,
      )}`;
      throw new Response(null, {
        status: 308,
        headers: { Location: newPath + url.search },
      });
    }
  }
  const dir = docoPath(aliasResolved.ownerSlug, aliasResolved.docoSlug);
  const meta = await readDocoMetadata(dir);
  if (!meta) throw notFoundForAccessDenied(ownerSlug, docoSlug);
  const me = await getCurrentPrincipalAsync(request);
  if (!(await canAccessDoco(meta, me?.id ?? null))) {
    throw notFoundForAccessDenied(ownerSlug, docoSlug);
  }
  return {
    dir,
    meta,
    me,
    canonicalOwnerSlug: aliasResolved.ownerSlug,
    canonicalDocoSlug: aliasResolved.docoSlug,
    redirected: aliasResolved.redirected || ownerResolved.redirected,
  };
}

/**
 * Same as `loadDocoForRead` but also requires admin rights.
 */
export async function loadDocoForAdmin(
  request: Request,
  ownerSlug: string,
  docoSlug: string,
): Promise<{ dir: string; meta: DocoMetadata; me: CurrentPrincipal | null }> {
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug);
  if (!(await canAdminDoco(ctx.meta, ctx.me?.id ?? null))) {
    throw new Response("Forbidden: only the Doco's owner can edit this.", { status: 403 });
  }
  return ctx;
}
