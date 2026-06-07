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

/** Map a raw `pull_request` object → GitHubPullRequest, or null if unusable.
 *  Pure; defensive about the untrusted shape. `merged` is inferred from
 *  `merged_at` when GitHub omits the boolean (list/webhook payloads vary). */
function extractPullRequest(
  prRaw: RawPullRequestPayload["pull_request"],
): GitHubPullRequest | null {
  if (!prRaw) return null;
  if (typeof prRaw.number !== "number" || typeof prRaw.html_url !== "string") return null;
  return {
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
}

/**
 * Pull the PR, repo, installation, and action out of a `pull_request` webhook
 * payload, or null if it isn't a usable PR event. Pure; defensive about the
 * untrusted shape.
 */
export function parsePullRequestEvent(payload: unknown): ParsedPullRequestEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as RawPullRequestPayload;
  const repoFullName = p.repository?.full_name;
  if (typeof repoFullName !== "string") return null;
  const pr = extractPullRequest(p.pull_request);
  if (!pr) return null;
  return {
    action: typeof p.action === "string" ? p.action : "",
    repoFullName,
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
    pr,
  };
}

export interface ParsedPullRequestReviewEvent {
  /** "submitted" | "edited" | "dismissed". */
  action: string;
  /** "approved" | "changes_requested" | "commented" | "dismissed" | "". */
  reviewState: string;
  repoFullName: string;
  installationId: number | null;
  pr: GitHubPullRequest;
}

/**
 * Parse a `pull_request_review` webhook — GitHub sends it when a review is
 * submitted/edited/dismissed on a PR. The payload embeds the full
 * `pull_request`, so we can re-sync the Reference and, on an approving review,
 * lift an open PR to active. Pure; defensive about the untrusted shape.
 */
export function parsePullRequestReviewEvent(payload: unknown): ParsedPullRequestReviewEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as RawPullRequestPayload & { review?: { state?: unknown } };
  const repoFullName = p.repository?.full_name;
  if (typeof repoFullName !== "string") return null;
  const pr = extractPullRequest(p.pull_request);
  if (!pr) return null;
  return {
    action: typeof p.action === "string" ? p.action : "",
    reviewState: typeof p.review?.state === "string" ? p.review.state.toLowerCase() : "",
    repoFullName,
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
    pr,
  };
}

export interface ParsedInstallationEvent {
  /** "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted". */
  action: string;
  installationId: number | null;
}

/**
 * Parse an `installation` webhook — GitHub sends it when the App is installed
 * or **uninstalled** on an account. The "deleted" action is the uninstall: the
 * caller detaches that installation (and its repo connections) from every Doco.
 * Pure; defensive about the untrusted shape.
 */
export function parseInstallationEvent(payload: unknown): ParsedInstallationEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { action?: unknown; installation?: { id?: unknown } };
  return {
    action: typeof p.action === "string" ? p.action : "",
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
  };
}

export interface ParsedInstallationReposEvent {
  /** "added" | "removed" (GitHub also sends this on install with all repos). */
  action: string;
  installationId: number | null;
  /** Full names ("owner/name") of repos newly granted to the installation. */
  addedRepos: string[];
  /** Full names of repos whose access was revoked from the installation. */
  removedRepos: string[];
}

/** Pull "owner/name" strings out of a raw repositories array. Pure. */
function repoFullNames(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .map((r) =>
          r && typeof r === "object" && typeof (r as { full_name?: unknown }).full_name === "string"
            ? (r as { full_name: string }).full_name
            : null,
        )
        .filter((x): x is string => x !== null)
    : [];
}

/**
 * Parse an `installation_repositories` webhook — GitHub sends it when repos are
 * added to (or removed from) an org installation. The "added" case backfills a
 * newly-covered repo's *pre-existing* PRs (brand-new PRs arrive via the
 * `pull_request` event); the "removed" case detaches those repos' connections.
 * Pure; defensive about the untrusted shape.
 */
export function parseInstallationRepositoriesEvent(
  payload: unknown,
): ParsedInstallationReposEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    action?: unknown;
    installation?: { id?: unknown };
    repositories_added?: unknown;
    repositories_removed?: unknown;
  };
  return {
    action: typeof p.action === "string" ? p.action : "",
    installationId: typeof p.installation?.id === "number" ? p.installation.id : null,
    addedRepos: repoFullNames(p.repositories_added),
    removedRepos: repoFullNames(p.repositories_removed),
  };
}

export interface DocoRepoConnection {
  docoId: string;
  handle: string;
  workspaceHandle: string;
}

/** Docos subscribed to every repository under a GitHub App installation. */
export async function findDocoByInstallation(
  installationId: number,
): Promise<DocoRepoConnection[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; workspace_handle: string }>(
      `SELECT d.id, d.handle, o.handle AS workspace_handle
         FROM docos d
         JOIN workspaces o ON o.id = d.workspace_id
        WHERE d.data->'github_integration'->'installations'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))
          AND d.deleted_at IS NULL
        `,
      [installationId],
    );
    return r.rows.map((row) => ({
      docoId: row.id,
      handle: row.handle,
      workspaceHandle: row.workspace_handle,
    }));
  });
}

/** Docos that should receive a repo event: either an org-wide subscription or
 * an explicit selected repository connection for that installation. */
export async function findDocoTargetsForGitHubRepo(
  installationId: number,
  repoFullName: string,
): Promise<DocoRepoConnection[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; workspace_handle: string }>(
      `SELECT d.id, d.handle, o.handle AS workspace_handle
         FROM docos d
         JOIN workspaces o ON o.id = d.workspace_id
        WHERE (d.data->'github_integration'->'installations'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))
           OR d.data->'github_integration'->'connections'
                @> jsonb_build_array(
                     jsonb_build_object('installation_id', $1::int, 'repo', $2::text)
                   ))
          AND d.deleted_at IS NULL`,
      [installationId, repoFullName],
    );
    return r.rows.map((row) => ({
      docoId: row.id,
      handle: row.handle,
      workspaceHandle: row.workspace_handle,
    }));
  });
}
