// Inbound GitHub App webhook. Verifies x-hub-signature-256 against
// DOCO_GITHUB_WEBHOOK_SECRET, then routes by App *installation* (not a repo
// list), so a brand-new repo in the org syncs automatically. Events handled:
//   - pull_request           → upsert the PR as a Reference in the subscribed Doco.
//   - pull_request_review     → an approving review lifts an open PR to asserted.
//   - installation_repositories (added)   → backfill the new repos' existing PRs.
//   - installation_repositories (removed) → detach those repos' connections.
//   - installation (deleted)  → uninstall: detach the installation everywhere.
// Idempotent on the PR URL / installation id, so re-deliveries are safe.
import { docoPath } from "~/lib/db.server";
import { listPullRequestFiles, mintInstallationToken } from "~/lib/github-app.server";
import { backfillInstallationRepos } from "~/lib/github-backfill.server";
import {
  addConnection,
  detachReposEverywhere,
  unsubscribeInstallationEverywhere,
} from "~/lib/github-connection.server";
import {
  type GitHubPullRequestFile,
  type PullRequestSyncStatus,
  hasBusinessProcessCodeReferences,
  upsertPullRequestReference,
} from "~/lib/github-pr-import.server";
import {
  findDocoByInstallation,
  parseInstallationEvent,
  parseInstallationRepositoriesEvent,
  parsePullRequestEvent,
  parsePullRequestReviewEvent,
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

interface ChangedFilesCache {
  token?: string;
  files?: GitHubPullRequestFile[];
}

async function changedFilesForDocoIfUseful(opts: {
  docoId: string;
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  cache: ChangedFilesCache;
}): Promise<GitHubPullRequestFile[] | undefined> {
  if (!(await hasBusinessProcessCodeReferences(opts.docoId))) return undefined;
  const [owner, repo] = opts.repoFullName.split("/");
  if (!owner || !repo) return undefined;
  if (!opts.cache.files) {
    opts.cache.token ??= (await mintInstallationToken(opts.installationId)).token;
    opts.cache.files = await listPullRequestFiles(opts.cache.token, owner, repo, opts.pullNumber);
  }
  return opts.cache.files;
}

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

  // App uninstalled from an account → detach that installation (and the repo
  // connections it carried) from every Doco, so nothing keeps trying to sync a
  // repo the App can no longer see.
  if (event === "installation") {
    const evt = parseInstallationEvent(payload);
    if (!evt || evt.installationId == null || evt.action !== "deleted") {
      return Response.json({ ok: true, ignored: true });
    }
    await unsubscribeInstallationEverywhere(evt.installationId);
    console.info(`[github webhook] installation deleted (${evt.installationId}) → detached`);
    return Response.json({ ok: true, event, action: evt.action, detached: evt.installationId });
  }

  // Repos added to / removed from an org installation.
  if (event === "installation_repositories") {
    const evt = parseInstallationRepositoriesEvent(payload);
    if (!evt || evt.installationId == null) {
      return Response.json({ ok: true, ignored: true });
    }
    // Removed → drop those repos' connections (access was revoked).
    if (evt.action === "removed" && evt.removedRepos.length > 0) {
      await detachReposEverywhere(evt.removedRepos);
      console.info(
        `[github webhook] installation_repositories removed [${evt.removedRepos.join(", ")}] (installation ${evt.installationId}) → detached`,
      );
      return Response.json({ ok: true, event, removed: evt.removedRepos.length });
    }
    // Added → backfill the new repos' pre-existing PRs (brand-new PRs arrive
    // via pull_request under the same installation id).
    if (evt.action !== "added" || evt.addedRepos.length === 0) {
      return Response.json({ ok: true, ignored: true });
    }
    const docos = await findDocoByInstallation(evt.installationId);
    console.info(
      `[github webhook] installation_repositories added [${evt.addedRepos.join(", ")}] (installation ${evt.installationId}) → ${docos.length} subscribed doco(s)`,
    );
    const added: Array<{ doco: string; repos: number; created: number; failed: number }> = [];
    const connectedAt = new Date().toISOString();
    for (const conn of docos) {
      // Record the new repos as connections so they show on the Integrations
      // page (and feed re-import), not just import their PRs.
      for (const repo of evt.addedRepos) {
        await addConnection(conn.docoId, {
          repo,
          installation_id: evt.installationId,
          connected_at: connectedAt,
        });
      }
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

  // An approving review lifts an open PR to asserted (the team signed off). The
  // payload embeds the full PR, so we re-sync the Reference with the approval
  // hint. Other review states (commented / changes_requested) are no-ops.
  if (event === "pull_request_review") {
    const evt = parsePullRequestReviewEvent(payload);
    if (
      !evt ||
      evt.action !== "submitted" ||
      evt.reviewState !== "approved" ||
      evt.installationId == null
    ) {
      return Response.json({ ok: true, ignored: true });
    }
    const docos = await findDocoByInstallation(evt.installationId);
    console.info(
      `[github webhook] review approved ${evt.repoFullName}#${evt.pr.number} (installation ${evt.installationId}) → ${docos.length} subscribed doco(s)`,
    );
    const results: Array<{ doco: string; status: PullRequestSyncStatus }> = [];
    const changedFilesCache: ChangedFilesCache = {};
    for (const conn of docos) {
      let changedFiles: GitHubPullRequestFile[] | undefined;
      try {
        changedFiles = await changedFilesForDocoIfUseful({
          docoId: conn.docoId,
          installationId: evt.installationId,
          repoFullName: evt.repoFullName,
          pullNumber: evt.pr.number,
          cache: changedFilesCache,
        });
      } catch (error) {
        console.warn(
          `[github webhook] unable to list files for ${evt.repoFullName}#${evt.pr.number}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const res = await upsertPullRequestReference(evt.pr, {
        docoDir: docoPath(conn.handle),
        docoId: conn.docoId,
        ownerSlug: conn.orgHandle,
        docoSlug: conn.handle,
        approved: true,
        ...(changedFiles ? { changedFiles } : {}),
      });
      results.push({ doco: conn.handle, status: res.status });
    }
    return Response.json({ ok: true, event, repo: evt.repoFullName, results });
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
  const changedFilesCache: ChangedFilesCache = {};
  for (const conn of docos) {
    let changedFiles: GitHubPullRequestFile[] | undefined;
    try {
      changedFiles = await changedFilesForDocoIfUseful({
        docoId: conn.docoId,
        installationId: parsed.installationId,
        repoFullName: parsed.repoFullName,
        pullNumber: parsed.pr.number,
        cache: changedFilesCache,
      });
    } catch (error) {
      console.warn(
        `[github webhook] unable to list files for ${parsed.repoFullName}#${parsed.pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const res = await upsertPullRequestReference(parsed.pr, {
      docoDir: docoPath(conn.handle),
      docoId: conn.docoId,
      ownerSlug: conn.orgHandle,
      docoSlug: conn.handle,
      ...(changedFiles ? { changedFiles } : {}),
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
