import { createHmac, timingSafeEqual } from "node:crypto";

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

export function hasValidSignupInviteCookie(cookieHeader: string | null, now = Date.now()): boolean {
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
