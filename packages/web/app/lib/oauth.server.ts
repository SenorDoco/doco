import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * GitHub OAuth helper (ADR-095).
 *
 * Localhost + production share the same flow. Differs only in the
 * registered OAuth app (client id/secret) and the callback URL.
 */

const STATE_COOKIE_NAME = "doco_oauth_state";
const RETURN_COOKIE_NAME = "doco_oauth_return";
const STATE_TTL_SECONDS = 600; // 10 minutes

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";
const GITHUB_EMAILS = "https://api.github.com/user/emails";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public-facing callback URL (matches what's registered with the GitHub app). */
  redirectUri: string;
  /** HMAC key used to sign the state cookie. Per-host secret; read from DOCO_GITHUB_STATE_KEY or generated. */
  stateKey: Buffer;
}

export function readOAuthConfig(request: Request): OAuthConfig | null {
  const clientId = process.env.DOCO_GITHUB_CLIENT_ID;
  const clientSecret = process.env.DOCO_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const url = new URL(request.url);
  const redirectUri =
    process.env.DOCO_GITHUB_REDIRECT_URI ?? `${url.protocol}//${url.host}/auth/github/callback`;

  const stateKeyRaw = process.env.DOCO_GITHUB_STATE_KEY ?? "doco-dev-default-state-key";
  return {
    clientId,
    clientSecret,
    redirectUri,
    stateKey: Buffer.from(stateKeyRaw, "utf8"),
  };
}

/** Build the GitHub authorize URL + the cookie that pins the state. */
export function startOAuth(config: OAuthConfig): { url: string; setCookie: string } {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${nonce}.${issuedAt}`;
  const sig = sign(payload, config.stateKey);
  const state = `${payload}.${sig}`;

  const authorizeUrl = new URL(GITHUB_AUTHORIZE);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("scope", "read:user user:email");
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("state", state);
  // Make GitHub show the account picker instead of silently bouncing a
  // still-logged-in user straight back in. Without this, signing out of
  // Doco feels broken: the cookie is cleared, but the next "Continue with
  // GitHub" silently re-authorizes the live GitHub session with no prompt,
  // so the user lands back on the dashboard "right away." prompt=select_account
  // forces a deliberate step. (allow_signup defaults to true, so it's omitted.)
  authorizeUrl.searchParams.set("prompt", "select_account");

  const setCookie = `${STATE_COOKIE_NAME}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`;
  return { url: authorizeUrl.toString(), setCookie };
}

/** Verify the returned `state` matches the cookie + signature + TTL. */
export function verifyOAuthState(
  config: OAuthConfig,
  returnedState: string,
  cookieHeader: string | null,
): "valid" | "missing_cookie" | "mismatch" | "expired" | "bad_signature" {
  if (!cookieHeader) return "missing_cookie";
  const cookieState = parseCookie(cookieHeader, STATE_COOKIE_NAME);
  if (!cookieState) return "missing_cookie";
  if (
    cookieState.length !== returnedState.length ||
    !timingSafeEqual(Buffer.from(cookieState), Buffer.from(returnedState))
  ) {
    return "mismatch";
  }
  const parts = returnedState.split(".");
  if (parts.length !== 3) return "bad_signature";
  const [nonce, issuedAtStr, sig] = parts as [string, string, string];
  const expected = sign(`${nonce}.${issuedAtStr}`, config.stateKey);
  if (sig !== expected) return "bad_signature";
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || Date.now() / 1000 - issuedAt > STATE_TTL_SECONDS) {
    return "expired";
  }
  return "valid";
}

export function clearOAuthStateCookie(): string {
  return `${STATE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Cookie that captures where to redirect after a successful OAuth
 * round-trip. Set by /auth/github when called with a `?return=` query
 * param; read by /auth/github/callback. Only same-origin paths
 * (starting with "/") are honored — never accept absolute URLs to
 * prevent open-redirect abuse.
 */
export function setOAuthReturnCookie(returnPath: string): string {
  return `${RETURN_COOKIE_NAME}=${encodeURIComponent(returnPath)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`;
}

export function clearOAuthReturnCookie(): string {
  return `${RETURN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readOAuthReturnCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";").map((p) => p.trim())) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) !== RETURN_COOKIE_NAME) continue;
    const value = decodeURIComponent(part.slice(eq + 1));
    if (!value.startsWith("/")) return null; // same-origin only
    if (value.startsWith("//")) return null; // protocol-relative — reject
    return value;
  }
  return null;
}

export interface GitHubUser {
  id: number; // numeric GitHub id, stable across login renames
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Exchange the OAuth `code` for an access token. */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
): Promise<{ accessToken: string }> {
  const res = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new Error(`GitHub token exchange returned no access_token: ${body.error ?? "unknown"}`);
  }
  return { accessToken: body.access_token };
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch(GITHUB_USER, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Doco",
    },
  });
  if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
  return (await res.json()) as GitHubUser;
}

/** Returns the primary verified email; falls back to the first verified, then any. */
export async function fetchGitHubPrimaryEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GITHUB_EMAILS, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Doco",
    },
  });
  if (!res.ok) return null;
  const list = (await res.json()) as GitHubEmail[];
  const primaryVerified = list.find((e) => e.primary && e.verified);
  if (primaryVerified) return primaryVerified.email;
  const verified = list.find((e) => e.verified);
  if (verified) return verified.email;
  return list[0]?.email ?? null;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";").map((p) => p.trim())) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) !== name) continue;
    return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
