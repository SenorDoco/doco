// GitHub App authentication + a minimal raw-fetch API client.
//
// A GitHub App authenticates server-to-server in two hops:
//   1. Sign a short-lived RS256 JWT with the App's private key (iss = app id).
//   2. Exchange it for an installation access token (POST /app/installations/
//      <id>/access_tokens), which is what we use for repo API calls.
//
// No octokit dependency — plain `fetch`, consistent with the codebase. The
// webhook + backfill increments call mintInstallationToken + listRepoPullRequests
// and feed the results to upsertPullRequestReference (github-pr-import.server).
//
// Config (set by the repo owner once the App is registered — see the settings
// panel / docs): DOCO_GITHUB_APP_ID, DOCO_GITHUB_APP_PRIVATE_KEY (PEM; literal
// "\n" escapes are tolerated for single-line env vars).
import { createSign } from "node:crypto";
import type { GitHubPullRequest } from "./github-pr-import.server";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/** Whether the GitHub App credentials are present in the environment. */
export function githubAppConfigured(): boolean {
  return Boolean(process.env.DOCO_GITHUB_APP_ID && process.env.DOCO_GITHUB_APP_PRIVATE_KEY);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** PEM keys pasted into single-line env vars often arrive with literal `\n`. */
function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/**
 * Build a short-lived RS256 JWT for GitHub App auth. `iat` is backdated 60s for
 * clock skew and `exp` is capped at GitHub's 10-minute ceiling. Pure given the
 * key and clock. The default TTL leaves `exp - iat = 600` (the maximum).
 */
export function buildAppJwt(opts: {
  appId: string;
  privateKey: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): string {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(opts.ttlSeconds ?? 540, 540);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + ttl, iss: opts.appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(normalizePem(opts.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expires_at: string;
}

/**
 * Mint an installation access token for a given installation id. Reads the App
 * credentials from the environment unless overridden (tests pass a fetchImpl +
 * key). The token is short-lived (~1h); callers mint per sync run.
 */
export async function mintInstallationToken(
  installationId: string | number,
  opts?: { appId?: string; privateKey?: string; fetchImpl?: typeof fetch },
): Promise<InstallationToken> {
  const appId = opts?.appId ?? process.env.DOCO_GITHUB_APP_ID ?? "";
  const privateKey = opts?.privateKey ?? process.env.DOCO_GITHUB_APP_PRIVATE_KEY ?? "";
  if (!appId || !privateKey) {
    throw new Error(
      "GitHub App not configured (DOCO_GITHUB_APP_ID / DOCO_GITHUB_APP_PRIVATE_KEY).",
    );
  }
  const jwt = buildAppJwt({ appId, privateKey });
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!res.ok) {
    throw new Error(`installation token mint failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as InstallationToken;
  return { token: body.token, expires_at: body.expires_at };
}

async function githubGet<T>(
  token: string,
  path: string,
  fetchImpl?: typeof fetch,
): Promise<{ data: T; linkHeader: string | null }> {
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  }
  return { data: (await res.json()) as T, linkHeader: res.headers.get("link") };
}

/**
 * List every pull request for a repo (state=all), following pagination until
 * there's no `rel="next"` link (or maxPages is hit). Used by the backfill.
 */
export async function listRepoPullRequests(
  token: string,
  owner: string,
  repo: string,
  opts?: { fetchImpl?: typeof fetch; perPage?: number; maxPages?: number },
): Promise<GitHubPullRequest[]> {
  const per = opts?.perPage ?? 100;
  const maxPages = opts?.maxPages ?? 50;
  const out: GitHubPullRequest[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, linkHeader } = await githubGet<GitHubPullRequest[]>(
      token,
      `/repos/${owner}/${repo}/pulls?state=all&per_page=${per}&page=${page}`,
      opts?.fetchImpl,
    );
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (!linkHeader || !linkHeader.includes('rel="next"')) break;
  }
  return out;
}
