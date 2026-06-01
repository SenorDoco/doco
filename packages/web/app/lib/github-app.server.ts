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
import type { GitHubPullRequest, GitHubPullRequestFile } from "./github-pr-import.server";

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

/**
 * Coerce a PEM private key into a form OpenSSL can decode. Env vars mangle PEMs
 * in predictable ways — literal `\n` escapes (single-line values), surrounding
 * quotes, CRLF, or newlines collapsed to spaces — any of which makes
 * `createSign().sign()` throw `DECODER routines::unsupported`. Repair all of
 * them. Pure.
 */
export function normalizePem(pem: string): string {
  let key = pem.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");
  key = key.replace(/\r\n?/g, "\n");
  // Newlines stripped entirely (e.g. collapsed to spaces): rebuild from the
  // BEGIN/END markers + the base64 body wrapped at 64 chars.
  if (!key.includes("\n")) {
    const m = /-----BEGIN ([A-Z0-9 ]+?)-----(.+?)-----END \1-----/.exec(key);
    if (m) {
      const label = m[1].trim();
      const body = m[2].replace(/\s+/g, "");
      const wrapped = (body.match(/.{1,64}/g) ?? []).join("\n");
      key = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
    }
  }
  return key;
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

export interface InstallationAccount {
  account: string;
  repository_selection?: "all" | "selected";
}

/**
 * Read the account login for a GitHub App installation. The setup callback
 * stores this as the durable org/owner subscription label, even before any
 * repositories have been imported.
 */
export async function getInstallationAccount(
  installationId: string | number,
  opts?: { appId?: string; privateKey?: string; fetchImpl?: typeof fetch },
): Promise<InstallationAccount> {
  const appId = opts?.appId ?? process.env.DOCO_GITHUB_APP_ID ?? "";
  const privateKey = opts?.privateKey ?? process.env.DOCO_GITHUB_APP_PRIVATE_KEY ?? "";
  if (!appId || !privateKey) {
    throw new Error(
      "GitHub App not configured (DOCO_GITHUB_APP_ID / DOCO_GITHUB_APP_PRIVATE_KEY).",
    );
  }
  const jwt = buildAppJwt({ appId, privateKey });
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}/app/installations/${installationId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!res.ok) {
    throw new Error(`installation fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    account?: { login?: unknown };
    repository_selection?: unknown;
  };
  const account = typeof body.account?.login === "string" ? body.account.login : "";
  if (!account) throw new Error("installation fetch returned no account login");
  return {
    account,
    ...(body.repository_selection === "all" || body.repository_selection === "selected"
      ? { repository_selection: body.repository_selection }
      : {}),
  };
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

export interface RepoPullRequestsPage {
  prs: GitHubPullRequest[];
  /** True when there are additional pages beyond the fetched window. */
  hasMore: boolean;
}

/**
 * List pull requests for a repo (state=all), starting at `startPage` and
 * fetching up to `maxPages` pages. Returns `{ prs, hasMore }` so callers can
 * implement cursor-based pagination without hitting serverless timeouts.
 */
export async function listRepoPullRequests(
  token: string,
  owner: string,
  repo: string,
  opts?: { fetchImpl?: typeof fetch; perPage?: number; maxPages?: number; startPage?: number },
): Promise<RepoPullRequestsPage> {
  const per = opts?.perPage ?? 100;
  const maxPages = opts?.maxPages ?? 50;
  const startPage = opts?.startPage ?? 1;
  const prs: GitHubPullRequest[] = [];
  let hasMore = false;
  for (let page = startPage; page < startPage + maxPages; page++) {
    const { data, linkHeader } = await githubGet<GitHubPullRequest[]>(
      token,
      `/repos/${owner}/${repo}/pulls?state=all&per_page=${per}&page=${page}`,
      opts?.fetchImpl,
    );
    if (!Array.isArray(data) || data.length === 0) break;
    prs.push(...data);
    if (!linkHeader || !linkHeader.includes('rel="next"')) break;
    if (page === startPage + maxPages - 1) hasMore = true;
  }
  return { prs, hasMore };
}

/**
 * List changed files for one pull request. GitHub includes a unified `patch`
 * for text files; binary/large files may omit it, and those simply don't
 * participate in line-level Doco linking.
 */
export async function listPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  opts?: { fetchImpl?: typeof fetch; perPage?: number; maxPages?: number },
): Promise<GitHubPullRequestFile[]> {
  const per = opts?.perPage ?? 100;
  const maxPages = opts?.maxPages ?? 10;
  const files: GitHubPullRequestFile[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, linkHeader } = await githubGet<GitHubPullRequestFile[]>(
      token,
      `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${per}&page=${page}`,
      opts?.fetchImpl,
    );
    if (!Array.isArray(data) || data.length === 0) break;
    files.push(
      ...data
        .filter((f) => typeof f.filename === "string")
        .map((f) => ({ filename: f.filename, patch: f.patch ?? null })),
    );
    if (!linkHeader || !linkHeader.includes('rel="next"')) break;
  }
  return files;
}

/**
 * List the repos an installation can access (as "owner/name" full names),
 * following pagination. The setup callback uses this to auto-capture which
 * repos a fresh install covers.
 */
export async function listInstallationRepos(
  token: string,
  opts?: {
    account?: string;
    fetchImpl?: typeof fetch;
    maxPages?: number;
    repositorySelection?: "all" | "selected";
  },
): Promise<string[]> {
  const maxPages = opts?.maxPages ?? 20;
  const out: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, linkHeader } = await githubGet<{ repositories?: { full_name?: string }[] }>(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
      opts?.fetchImpl,
    );
    const repos = data.repositories ?? [];
    for (const r of repos) {
      if (typeof r.full_name === "string") out.push(r.full_name);
    }
    if (repos.length === 0 || !linkHeader || !linkHeader.includes('rel="next"')) break;
  }
  if (out.length === 0 && opts?.account && opts.repositorySelection === "all") {
    return listInstallationAccountRepos(token, opts.account, {
      fetchImpl: opts.fetchImpl,
      maxPages,
    });
  }
  return out;
}

async function listInstallationAccountRepos(
  token: string,
  account: string,
  opts?: { fetchImpl?: typeof fetch; maxPages?: number },
): Promise<string[]> {
  const maxPages = opts?.maxPages ?? 20;
  const doFetch = opts?.fetchImpl ?? fetch;
  const out: string[] = [];
  for (const ownerPath of [`/orgs/${account}/repos`, `/users/${account}/repos`]) {
    out.length = 0;
    for (let page = 1; page <= maxPages; page++) {
      const res = await doFetch(`${GITHUB_API}${ownerPath}?type=all&per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
      if (!res.ok) {
        if (page === 1 && (res.status === 404 || res.status === 403)) break;
        throw new Error(`GitHub GET ${ownerPath} failed: ${res.status}`);
      }
      const data = (await res.json()) as { full_name?: unknown }[];
      const repos = Array.isArray(data) ? data : [];
      for (const repo of repos) {
        if (typeof repo.full_name === "string") out.push(repo.full_name);
      }
      const linkHeader = res.headers.get("link");
      if (repos.length === 0 || !linkHeader || !linkHeader.includes('rel="next"')) break;
    }
    if (out.length > 0) return [...new Set(out)].sort();
  }
  return [];
}
