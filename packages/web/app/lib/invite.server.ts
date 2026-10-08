import { createHmac, timingSafeEqual } from "node:crypto";
import { getDocoById, upsertDocoUser, upsertWorkspaceUser, withClient } from "@doco/db";
import { type EntityId, WRITE_ALL } from "@doco/shared";
import { rootDir } from "~/lib/db.server";
import { type Invite, InviteStore } from "~/lib/invite-store.server";
import { startOnboarding } from "~/lib/onboarding.server";

const INVITE_COOKIE_NAME = "doco_signup_invite";
const INVITE_COOKIE_TTL_SECONDS = 10 * 60;
const INVITE_COOKIE_VERSION = "v1";
const SIGNUP_INVITE_CODE = "DOCO2026";

export function isValidSignupInviteCode(input: string): boolean {
  return input.trim() === SIGNUP_INVITE_CODE;
}

export function setSignupInviteCookie(now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const payload = `${INVITE_COOKIE_VERSION}.${issuedAt}`;
  const token = `${payload}.${sign(payload)}`;
  return `${INVITE_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${INVITE_COOKIE_TTL_SECONDS}`;
}

export function clearSignupInviteCookie(): string {
  return `${INVITE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Whether a newcomer may create an account: they entered the signup code, or
 * they are following an invite a user sent them. Signing in from
 * /invite/<code> returns there, and a pending invite minted by a user is the
 * newcomer's pass, so they need no code.
 */
export async function maySignUp(
  cookieHeader: string | null,
  returnPath: string | null,
): Promise<boolean> {
  if (hasValidSignupInviteCookie(cookieHeader)) return true;
  const code = inviteCodeIn(returnPath);
  if (!code) return false;
  const invite = await InviteStore.forDoco(rootDir()).findInvite(code);
  return invite?.status === "pending" && invite.minted_by_user_id !== null;
}

/** The invite code of an /invite/<code> path, or null for any other path. */
export function inviteCodeIn(path: string | null): string | null {
  return path?.match(/^\/invite\/([^/?#]+)$/)?.[1] ?? null;
}

/** What an invite grants, what to call it and where it leads: its workspace or
 *  Doco, or the workspaces list when it grants several. Null when its target
 *  is gone. */
export async function inviteTarget(
  invite: Invite,
): Promise<{ level: "doco" | "workspace"; label: string; to: string } | null> {
  const grant = invite.grants[0];
  if (!grant) return null;
  if (invite.grants.length > 1) {
    return {
      level: grant.level,
      label: `${invite.grants.length} access grants`,
      to: "/workspaces",
    };
  }
  if (grant.level === "workspace") {
    const handle = await workspaceHandle(grant.target_id);
    return handle ? { level: "workspace", label: handle, to: `/workspaces/${handle}` } : null;
  }
  const doco = await getDocoById(grant.target_id);
  return doco ? { level: "doco", label: doco.handle, to: `/${doco.handle}` } : null;
}

/**
 * Accept an invite for a signed-in person, from its page or on the way back
 * from signing in there: they join what it grants, and joining a workspace
 * starts its one step for them (ask your agent to start using Doco), which
 * its page keeps them on until it's done. Returns where to take them, or why
 * the invite can't be accepted.
 */
export async function acceptInvite(
  code: string,
  userId: string,
): Promise<{ to: string } | { error: string }> {
  const store = InviteStore.forDoco(rootDir());
  const invite = await store.findInvite(code);
  if (!invite) return { error: "Invite not found." };
  if (invite.status === "expired") return { error: "This invite has expired." };
  if (invite.status === "consumed") return { error: "This invite was already redeemed." };
  if (invite.status === "revoked") return { error: "This invite has been revoked." };

  const target = await inviteTarget(invite);
  if (!target) return { error: "The invite target no longer exists." };

  const consumed = await store.consumeInvite(code, userId as EntityId<"principal">);
  if (!consumed) {
    return {
      error:
        "This invite was claimed by someone else in the same moment. Ask the minter for a fresh one.",
    };
  }

  for (const g of consumed.grants) {
    const write_types =
      g.role === "writer" && g.write_types.length === 0 ? [WRITE_ALL] : g.write_types;
    if (g.level === "workspace") {
      await upsertWorkspaceUser({
        workspace_id: g.target_id,
        user_id: userId,
        role: g.role,
        write_types,
      });
      await withClient((c) =>
        startOnboarding(c, { workspaceId: g.target_id, userId, joinedAs: "invitee" }),
      );
    } else if (g.level === "doco") {
      await upsertDocoUser({ doco_id: g.target_id, user_id: userId, role: g.role, write_types });
    }
  }
  return { to: target.to };
}

async function workspaceHandle(id: string): Promise<string | null> {
  const result = await withClient((c) =>
    c.query<{ handle: string }>("SELECT handle FROM workspaces WHERE id = $1 LIMIT 1", [id]),
  );
  const row = result.rows[0];
  return row ? String(row.handle) : null;
}

function hasValidSignupInviteCookie(cookieHeader: string | null, now = Date.now()): boolean {
  const token = parseCookie(cookieHeader, INVITE_COOKIE_NAME);
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, issuedAtRaw, signature] = parts as [string, string, string];
  if (version !== INVITE_COOKIE_VERSION) return false;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;
  const nowSeconds = Math.floor(now / 1000);
  if (issuedAt > nowSeconds + 60) return false;
  if (nowSeconds - issuedAt > INVITE_COOKIE_TTL_SECONDS) return false;

  const payload = `${version}.${issuedAtRaw}`;
  return timingSafeStringEqual(signature, sign(payload));
}

function inviteCookieKey(): Buffer {
  return Buffer.from(
    process.env.DOCO_INVITE_COOKIE_KEY ??
      process.env.DOCO_GITHUB_STATE_KEY ??
      "doco-dev-default-invite-key",
    "utf8",
  );
}

function sign(payload: string): string {
  return createHmac("sha256", inviteCookieKey()).update(payload).digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";").map((p) => p.trim())) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) !== name) continue;
    return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
