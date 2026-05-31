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

export interface DocoRepoConnection {
  docoId: string;
  handle: string;
  orgHandle: string;
}

/**
 * Docos whose `data.github_integration.repo` equals "owner/name". Empty until
 * a repo is connected to a Doco (the settings panel, increment 5).
 */
export async function findDocoConnectionsByRepo(
  repoFullName: string,
): Promise<DocoRepoConnection[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; org_handle: string }>(
      `SELECT d.id, d.handle, o.handle AS org_handle
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.data->'github_integration'->>'repo' = $1`,
      [repoFullName],
    );
    return r.rows.map((row) => ({
      docoId: row.id,
      handle: row.handle,
      orgHandle: row.org_handle,
    }));
  });
}
