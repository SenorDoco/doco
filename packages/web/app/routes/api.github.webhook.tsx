// Inbound GitHub App webhook. Verifies x-hub-signature-256 against
// DOCO_GITHUB_WEBHOOK_SECRET, then for `pull_request` events upserts the PR as
// a Reference into the Doco subscribed to that *installation*. Routing on the
// installation id (not a repo list) means a brand-new repo in the org syncs
// automatically — GitHub delivers its webhooks under the same installation.
// Idempotent on the PR URL, so re-deliveries are safe.
import { docoPath } from "~/lib/db.server";
import {
  type PullRequestSyncStatus,
  upsertPullRequestReference,
} from "~/lib/github-pr-import.server";
import {
  findDocoByInstallation,
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
    // Surface the most common misconfiguration (no secret set on the server, or
    // a mismatch with the App's webhook secret) instead of failing silently.
    console.warn(
      `[github webhook] signature rejected (DOCO_GITHUB_WEBHOOK_SECRET configured: ${Boolean(secret)})`,
    );
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
  if (parsed.installationId == null) {
    return Response.json({ ok: true, ignored: "no installation id" });
  }
  const docos = await findDocoByInstallation(parsed.installationId);
  console.info(
    `[github webhook] ${parsed.action} ${parsed.repoFullName}#${parsed.pr.number} (installation ${parsed.installationId}) → ${docos.length} subscribed doco(s)`,
  );
  const results: Array<{ doco: string; status: PullRequestSyncStatus }> = [];
  for (const conn of docos) {
    const res = await upsertPullRequestReference(parsed.pr, {
      docoDir: docoPath(conn.handle),
      docoId: conn.docoId,
      ownerSlug: conn.orgHandle,
      docoSlug: conn.handle,
    });
    if (res.status === "error") {
      console.error(
        `[github webhook] upsert failed for ${parsed.pr.html_url} in ${conn.handle}: ${res.error}`,
      );
    }
    results.push({ doco: conn.handle, status: res.status });
  }
  return Response.json({
    ok: true,
    repo: parsed.repoFullName,
    installation_id: parsed.installationId,
    matched: docos.length,
    results,
  });
}
