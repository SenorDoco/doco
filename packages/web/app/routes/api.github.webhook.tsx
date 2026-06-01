// Inbound GitHub App webhook. Verifies x-hub-signature-256 against
// DOCO_GITHUB_WEBHOOK_SECRET, then routes by App *installation* (not a repo
// list), so a brand-new repo in the org syncs automatically. Two events:
//   - pull_request          → upsert the PR as a Reference in the subscribed Doco.
//   - installation_repositories (added) → backfill each newly-added repo's
//     pre-existing PRs (brand-new PRs arrive via pull_request).
// Idempotent on the PR URL, so re-deliveries are safe.
import { docoPath } from "~/lib/db.server";
import { backfillInstallationRepos } from "~/lib/github-backfill.server";
import {
  type PullRequestSyncStatus,
  upsertPullRequestReference,
} from "~/lib/github-pr-import.server";
import {
  findDocoByInstallation,
  parseInstallationRepositoriesEvent,
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
  const event = request.headers.get("x-github-event");
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Repos added to an org installation → backfill their pre-existing PRs.
  if (event === "installation_repositories") {
    const evt = parseInstallationRepositoriesEvent(payload);
    if (
      !evt ||
      evt.action !== "added" ||
      evt.installationId == null ||
      evt.addedRepos.length === 0
    ) {
      return Response.json({ ok: true, ignored: true });
    }
    const docos = await findDocoByInstallation(evt.installationId);
    console.info(
      `[github webhook] installation_repositories added [${evt.addedRepos.join(", ")}] (installation ${evt.installationId}) → ${docos.length} subscribed doco(s)`,
    );
    const added: Array<{ doco: string; repos: number; created: number; failed: number }> = [];
    for (const conn of docos) {
      const r = await backfillInstallationRepos({
        docoDir: docoPath(conn.handle),
        docoId: conn.docoId,
        ownerSlug: conn.orgHandle,
        docoSlug: conn.handle,
        repos: evt.addedRepos,
        installationId: evt.installationId,
      });
      added.push({ doco: conn.handle, repos: r.repos, created: r.created, failed: r.failed });
    }
    return Response.json({
      ok: true,
      event,
      added: evt.addedRepos.length,
      matched: docos.length,
      results: added,
    });
  }

  if (event !== "pull_request") {
    return Response.json({ ok: true, ignored: "unhandled event" });
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
