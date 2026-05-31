// Inbound GitHub webhook helpers: signature verification + payload parsing +
// repo→Doco routing. The route (routes/api.github.webhook.tsx) wires these to
// upsertPullRequestReference. Signature verification mirrors the Slack verifier
// already in the codebase (HMAC over the raw body, constant-time compare).
import { createHmac, timingSafeEqual } from "node:crypto";
import { withClient } from "@doco/db";
import type { GitHubPullRequest } from "./github-pr-import.server";

/**
 * Verify GitHub's `x-hub-signature-256` header — HMAC-SHA256 over the raw
 * request body, compared in constant time. Pure. Returns false on any
 * missing/short-circuit input so the caller can reject with a 401.
 */
export function verifyGitHubSignature(args: {
  rawBody: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!args.signature || !args.secret) return false;
  const expected = `sha256=${createHmac("sha256", args.secret).update(args.rawBody).digest("hex")}`;
  const a = Buffer.from(args.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface RawPullRequestPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  installation?: { id?: unknown };
  pull_request?: {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    state?: unknown;
    draft?: unknown;
    merged?: unknown;
    merged_at?: unknown;
    closed_at?: unknown;
    user?: { login?: unknown } | null;
  };
}

export interface ParsedPullRequestEvent {
  action: string;
  repoFullName: string;
  installationId: number | null;
  pr: GitHubPullRequest;
}

/**
 * Pull the PR, repo, installation, and action out of a `pull_request` webhook
 * payload, or null if it isn't a usable PR event. Pure; defensive about the
 * untrusted shape. `merged` is inferred from `merged_at` when GitHub omits the
 * boolean (the list/webhook payloads don't always include it).
 */
export function parsePullRequestEvent(payload: unknown): ParsedPullRequestEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as RawPullRequestPayload;
  const prRaw = p.pull_request;
  const repoFullName = p.repository?.full_name;
  if (!prRaw || typeof repoFullName !== "string") return null;
  if (typeof prRaw.number !== "number" || typeof prRaw.html_url !== "string") return null;
  const pr: GitHubPullRequest = {
    number: prRaw.number,
    title: typeof prRaw.title === "string" ? prRaw.title : "",
    body: typeof prRaw.body === "string" ? prRaw.body : null,
    html_url: prRaw.html_url,
    state: prRaw.state === "closed" ? "closed" : "open",
    draft: typeof prRaw.draft === "boolean" ? prRaw.draft : undefined,
    merged: typeof prRaw.merged === "boolean" ? prRaw.merged : Boolean(prRaw.merged_at),
    merged_at: typeof prRaw.merged_at === "string" ? prRaw.merged_at : null,
    closed_at: typeof prRaw.closed_at === "string" ? prRaw.closed_at : null,
    user: prRaw.user && typeof prRaw.user.login === "string" ? { login: prRaw.user.login } : null,
  };
  return {
    action: typeof p.action === "string" ? p.action : "",
    repoFullName,
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
    pr,
  };
}

export interface ParsedInstallationReposEvent {
  /** "added" | "removed" (GitHub also sends this on install with all repos). */
  action: string;
  installationId: number | null;
  /** Full names ("owner/name") of repos newly granted to the installation. */
  addedRepos: string[];
}

/**
 * Parse an `installation_repositories` webhook — GitHub sends it when repos are
 * added to (or removed from) an org installation. We use the "added" case to
 * backfill a newly-covered repo's *pre-existing* PRs; brand-new PRs already
 * arrive via the `pull_request` event under the same installation id. Pure;
 * defensive about the untrusted shape.
 */
export function parseInstallationRepositoriesEvent(
  payload: unknown,
): ParsedInstallationReposEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    action?: unknown;
    installation?: { id?: unknown };
    repositories_added?: unknown;
  };
  const addedRepos = Array.isArray(p.repositories_added)
    ? p.repositories_added
        .map((r) =>
          r && typeof r === "object" && typeof (r as { full_name?: unknown }).full_name === "string"
            ? (r as { full_name: string }).full_name
            : null,
        )
        .filter((x): x is string => x !== null)
    : [];
  return {
    action: typeof p.action === "string" ? p.action : "",
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
    addedRepos,
  };
}

export interface DocoRepoConnection {
  docoId: string;
  handle: string;
  orgHandle: string;
}

/**
 * Docos connected to "owner/name". Matches both the list shape
 * (`data.github_integration.connections[].repo`) and the legacy single shape
 * (`data.github_integration.repo`).
 */
export async function findDocoConnectionsByRepo(
  repoFullName: string,
): Promise<DocoRepoConnection[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; org_handle: string }>(
      `SELECT d.id, d.handle, o.handle AS org_handle
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.data->'github_integration'->>'repo' = $1
           OR d.data->'github_integration'->'connections'
                @> jsonb_build_array(jsonb_build_object('repo', $1::text))`,
      [repoFullName],
    );
    return r.rows.map((row) => ({
      docoId: row.id,
      handle: row.handle,
      orgHandle: row.org_handle,
    }));
  });
}

/**
 * The Doco subscribed to a GitHub App installation — the routing key. Matches
 * the org-subscription `installations[]` shape, any per-repo connection that
 * carries the installation id (back-compat with the earlier repo model), and
 * the legacy single shape. Routing on the installation (not a repo list) is
 * what makes a brand-new repo in the org sync automatically: GitHub delivers
 * its PR webhooks under the same installation id. One installation ↦ one Doco.
 */
export async function findDocoByInstallation(
  installationId: number,
): Promise<DocoRepoConnection[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; org_handle: string }>(
      `SELECT d.id, d.handle, o.handle AS org_handle
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.data->'github_integration'->'installations'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))
           OR d.data->'github_integration'->'connections'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))
           OR (d.data->'github_integration'->>'installation_id')::int = $1`,
      [installationId],
    );
    return r.rows.map((row) => ({
      docoId: row.id,
      handle: row.handle,
      orgHandle: row.org_handle,
    }));
  });
}
