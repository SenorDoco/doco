// Inbound GitHub App webhook. Verifies x-hub-signature-256 against
// DOCO_GITHUB_WEBHOOK_SECRET, then for `pull_request` events upserts the PR as
// a Reference into every Doco connected to that repo. Idempotent on the PR URL,
// so GitHub re-deliveries are safe. Repo→Doco wiring comes from the settings
// panel (increment 5); until a repo is connected this responds matched: 0.
import { docoPath } from "~/lib/db.server";
import { upsertPullRequestReference } from "~/lib/github-pr-import.server";
import {
  findDocoConnectionsByRepo,
  parsePullRequestEvent,
  verifyGitHubSignature,
} from "~/lib/github-webhook.server";

// PR actions worth syncing; others (assigned, review_requested, …) are no-ops.
const SYNC_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "labeled",
  "unlabeled",
]);

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  // Raw body is required for HMAC verification — read it before JSON.parse.
  const rawBody = await request.text();
  const secret = process.env.DOCO_GITHUB_WEBHOOK_SECRET ?? "";
  if (
    !verifyGitHubSignature({
      rawBody,
      signature: request.headers.get("x-hub-signature-256"),
      secret,
    })
  ) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  if (request.headers.get("x-github-event") !== "pull_request") {
    return Response.json({ ok: true, ignored: "non-pull_request event" });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parsePullRequestEvent(payload);
  if (!parsed || !SYNC_ACTIONS.has(parsed.action)) {
    return Response.json({ ok: true, ignored: true });
  }
  const connections = await findDocoConnectionsByRepo(parsed.repoFullName);
  const results: Array<{ doco: string; ok: boolean }> = [];
  for (const conn of connections) {
    const res = await upsertPullRequestReference(parsed.pr, {
      docoDir: docoPath(conn.handle),
      docoId: conn.docoId,
      ownerSlug: conn.orgHandle,
      docoSlug: conn.handle,
    });
    results.push({ doco: conn.handle, ok: !("error" in res) });
  }
  return Response.json({
    ok: true,
    repo: parsed.repoFullName,
    matched: connections.length,
    results,
  });
}
