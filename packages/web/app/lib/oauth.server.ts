import { randomBytes, timingSafeEqual } from "node:crypto";
import { readCookie } from "./cookie";
import { openToken, sealToken } from "./secret-box.server";

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
}

export function readOAuthConfig(request: Request): OAuthConfig | null {
  const clientId = process.env.DOCO_GITHUB_CLIENT_ID;
  const clientSecret = process.env.DOCO_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const url = new URL(request.url);
  const redirectUri =
    process.env.DOCO_GITHUB_REDIRECT_URI ?? `${url.protocol}//${url.host}/auth/github/callback`;

  return { clientId, clientSecret, redirectUri };
}

/** Build the GitHub authorize URL + the cookie that pins the state. */
export function startOAuth(config: OAuthConfig): { url: string; setCookie: string } {
  const state = sealToken(randomBytes(16).toString("hex"), STATE_TTL_SECONDS * 1000);

  const authorizeUrl = new URL(GITHUB_AUTHORIZE);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("scope", "read:user user:email");
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("state", state);
  // Make GitHub show the account picker instead of silently bouncing a
  // still-logged-in user straight back in. Without this, signing out of
  // Doco feels broken: the cookie is cleared, but the next "Continue with
  // GitHub" silently re-authorizes the live GitHub session with no prompt,
  // so the user lands back on their workspaces "right away." prompt=select_account
  // forces a deliberate step. (allow_signup defaults to true, so it's omitted.)
  authorizeUrl.searchParams.set("prompt", "select_account");

  const setCookie = `${STATE_COOKIE_NAME}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`;
  return { url: authorizeUrl.toString(), setCookie };
}

/** Whether the returned `state` is the one this browser's cookie pins, and
 *  one the server issued in the last ten minutes. */
export function verifyOAuthState(
  returnedState: string,
  cookieHeader: string | null,
): "valid" | "missing_cookie" | "mismatch" | "invalid" {
  const cookieState = readCookie(cookieHeader, STATE_COOKIE_NAME);
  if (!cookieState) return "missing_cookie";
  if (
    cookieState.length !== returnedState.length ||
    !timingSafeEqual(Buffer.from(cookieState), Buffer.from(returnedState))
  ) {
    return "mismatch";
  }
  return openToken(returnedState) === null ? "invalid" : "valid";
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
  const value = readCookie(cookieHeader, RETURN_COOKIE_NAME);
  if (!value?.startsWith("/")) return null; // same-origin only
  if (value.startsWith("//")) return null; // protocol-relative — reject
  return value;
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
