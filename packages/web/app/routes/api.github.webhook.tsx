// Inbound GitHub App webhook. Verifies x-hub-signature-256 against
// DOCO_GITHUB_WEBHOOK_SECRET, then routes repo events to the Docos that bring
// that kind of item from the repository (github-imports), whether they selected
// the repo or subscribed to the whole installation. Events handled:
//   - pull_request           → upsert the PR as a Reference in the pull requests Docos.
//   - pull_request_review     → an approving review lifts an open PR to active.
//   - issues                 → file, update or retire the bug in the GitHub bugs Docos.
//   - push (default branch)  → bring the changed files into the codebase Docos.
//   - installation_repositories (added)   → backfill the new repos' existing items.
//   - installation_repositories (removed) → detach those repos' connections.
//   - installation (deleted)  → uninstall: detach the installation everywhere.
// Idempotent on the item URL / installation id / file sha, so re-deliveries
// are safe.
import { waitUntil } from "@vercel/functions";
import { syncRepoCodebase } from "~/lib/codebase-sync.server";
import { docoPath } from "~/lib/db.server";
import { listPullRequestFiles, mintInstallationToken } from "~/lib/github-app.server";
import { backfillInstallationRepos } from "~/lib/github-backfill.server";
import {
  addConnection,
  detachReposEverywhere,
  unsubscribeInstallationEverywhere,
} from "~/lib/github-connection.server";
import { syncBugIssue } from "~/lib/github-issue-import.server";
import {
  type GitHubPullRequestFile,
  type GitHubSyncStatus,
  hasBusinessProcessCodeReferences,
  upsertPullRequestReference,
} from "~/lib/github-pr-import.server";
import {
  findDocoByInstallation,
  findDocoTargetsForGitHubRepo,
  parseInstallationEvent,
  parseInstallationRepositoriesEvent,
  parseIssuesEvent,
  parsePullRequestEvent,
  parsePullRequestReviewEvent,
  parsePushEvent,
  verifyGitHubSignature,
} from "~/lib/github-webhook.server";

// A push to a large repository can take a while to copy: give the walk the
// full function budget (syncRepoCodebase stops itself at 200s).
export const config = { maxDuration: 300 };

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
    // Added → backfill the new repos' pre-existing items, as each subscribed
    // Doco brings them (brand-new ones arrive as webhooks under the same
    // installation id).
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
        ownerSlug: conn.workspaceHandle,
        docoSlug: conn.handle,
        template: conn.template,
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

  // An approving review lifts an open PR to active (the team signed off). The
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
    const docos = await findDocoTargetsForGitHubRepo(
      evt.installationId,
      evt.repoFullName,
      "github-pull-requests",
    );
    console.info(
      `[github webhook] review approved ${evt.repoFullName}#${evt.pr.number} (installation ${evt.installationId}) → ${docos.length} subscribed doco(s)`,
    );
    const results: Array<{ doco: string; status: GitHubSyncStatus }> = [];
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
        ownerSlug: conn.workspaceHandle,
        docoSlug: conn.handle,
        approved: true,
        ...(changedFiles ? { changedFiles } : {}),
      });
      results.push({ doco: conn.handle, status: res.status });
    }
    return Response.json({ ok: true, event, repo: evt.repoFullName, results });
  }

  // An issue opened, edited, closed, reopened, (un)labeled, typed or deleted →
  // re-sync it into every GitHub bugs Doco bringing bugs from the repo. Whether it
  // is a bug is decided there, so a label added or removed files or retires it.
  if (event === "issues") {
    const evt = parseIssuesEvent(payload);
    if (!evt || evt.installationId == null) {
      return Response.json({ ok: true, ignored: true });
    }
    const docos = await findDocoTargetsForGitHubRepo(
      evt.installationId,
      evt.repoFullName,
      "github-bugs",
    );
    console.info(
      `[github webhook] issue ${evt.action} ${evt.repoFullName}#${evt.issue.number} (installation ${evt.installationId}) → ${docos.length} GitHub bugs Doco(s)`,
    );
    const results: Array<{ doco: string; status: GitHubSyncStatus }> = [];
    for (const conn of docos) {
      const res = await syncBugIssue(evt.issue, {
        docoDir: docoPath(conn.handle),
        docoId: conn.docoId,
        ownerSlug: conn.workspaceHandle,
        docoSlug: conn.handle,
        deleted: evt.action === "deleted",
      });
      if (res.status === "error") {
        console.error(
          `[github webhook] bug sync failed for ${evt.issue.html_url} in ${conn.handle}: ${res.error}`,
        );
      }
      results.push({ doco: conn.handle, status: res.status });
    }
    return Response.json({ ok: true, event, repo: evt.repoFullName, results });
  }

  // A push to the default branch → bring its changes into every codebase Doco
  // copying the repo, after answering GitHub (it waits 10s for a response).
  if (event === "push") {
    const evt = parsePushEvent(payload);
    if (!evt) return Response.json({ ok: true, ignored: true });
    const docos = await findDocoTargetsForGitHubRepo(
      evt.installationId,
      evt.repoFullName,
      "codebase",
    );
    console.info(
      `[github webhook] push ${evt.repoFullName} (installation ${evt.installationId}) → ${docos.length} codebase doco(s)`,
    );
    const [owner, repo] = evt.repoFullName.split("/");
    waitUntil(
      (async () => {
        for (const conn of docos) {
          try {
            await syncRepoCodebase({
              docoDir: docoPath(conn.handle),
              docoId: conn.docoId,
              ownerSlug: conn.workspaceHandle,
              docoSlug: conn.handle,
              owner,
              repo,
              installationId: evt.installationId,
            });
          } catch (error) {
            console.error(
              `[github webhook] codebase sync failed for ${evt.repoFullName} in ${conn.handle}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      })(),
    );
    return Response.json({
      ok: true,
      event,
      repo: evt.repoFullName,
      syncing: docos.map((d) => d.handle),
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
  const docos = await findDocoTargetsForGitHubRepo(
    parsed.installationId,
    parsed.repoFullName,
    "github-pull-requests",
  );
  console.info(
    `[github webhook] ${parsed.action} ${parsed.repoFullName}#${parsed.pr.number} (installation ${parsed.installationId}) → ${docos.length} subscribed doco(s)`,
  );
  const results: Array<{ doco: string; status: GitHubSyncStatus }> = [];
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
      ownerSlug: conn.workspaceHandle,
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
