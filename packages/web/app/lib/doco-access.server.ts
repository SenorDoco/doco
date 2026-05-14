// Privacy gate for Docos. Postgres-backed
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).

import { redirect } from "react-router";
import {
  getPrincipalById,
  isOrgAdmin as dbIsOrgAdmin,
  isOrgMember as dbIsOrgMember,
} from "@doco/db";
import { docoPath } from "./db.server";
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
  meta: { ownerId: string; visibility: string },
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
  return false;
}

/** True if ownerId is the host-bootstrap placeholder Principal (unclaimed Docos). */
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
 * Same as `canAccessDoco` but for write/admin operations.
 */
export async function canAdminDoco(
  meta: { ownerId: string },
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
  const aliasResolved = resolveDocoSlugAlias(ownerResolved.canonical, docoSlug);
  if (!aliasResolved) {
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
  const meta = readDocoMetadata(dir);
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
