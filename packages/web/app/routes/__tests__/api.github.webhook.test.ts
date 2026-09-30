import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  syncBugIssue,
  upsertPullRequestReference,
  hasBusinessProcessCodeReferences,
  mintInstallationToken,
  listPullRequestFiles,
  backfillInstallationRepos,
  addConnection,
  detachReposEverywhere,
  unsubscribeInstallationEverywhere,
  findDocoByInstallation,
  findDocoTargetsForGitHubRepo,
  syncRepoCodebase,
  waitUntil,
} = vi.hoisted(() => ({
  upsertPullRequestReference: vi.fn(async () => ({ status: "updated", id: "reference_x" })),
  hasBusinessProcessCodeReferences: vi.fn(async () => false),
  mintInstallationToken: vi.fn(async () => ({
    token: "ghs_test",
    expires_at: "2030-01-01T00:00:00Z",
  })),
  listPullRequestFiles: vi.fn(
    async (): Promise<Array<{ filename: string; patch: string | null }>> => [],
  ),
  backfillInstallationRepos: vi.fn(async () => ({
    repos: 1,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  })),
  addConnection: vi.fn(async () => []),
  detachReposEverywhere: vi.fn(async () => {}),
  unsubscribeInstallationEverywhere: vi.fn(async () => {}),
  findDocoByInstallation: vi.fn(async () => [
    { docoId: "doco_1", handle: "store", workspaceHandle: "acme", template: "bugs" },
  ]),
  findDocoTargetsForGitHubRepo: vi.fn(async () => [
    { docoId: "doco_1", handle: "store", workspaceHandle: "acme", template: null },
  ]),
  syncBugIssue: vi.fn(async () => ({ status: "created", id: "eval_x" })),
  syncRepoCodebase: vi.fn(async () => ({ done: true })),
  waitUntil: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/lib/github-issue-import.server", () => ({ syncBugIssue }));
vi.mock("~/lib/codebase-sync.server", () => ({ syncRepoCodebase }));
vi.mock("@vercel/functions", () => ({ waitUntil }));
vi.mock("~/lib/db.server", () => ({ docoPath: (h: string) => `/repos/${h}` }));
vi.mock("~/lib/github-app.server", () => ({ mintInstallationToken, listPullRequestFiles }));
vi.mock("~/lib/github-pr-import.server", () => ({
  upsertPullRequestReference,
  hasBusinessProcessCodeReferences,
}));
vi.mock("~/lib/github-backfill.server", () => ({ backfillInstallationRepos }));
vi.mock("~/lib/github-connection.server", () => ({
  addConnection,
  detachReposEverywhere,
  unsubscribeInstallationEverywhere,
}));
// Keep the real parsers + signature verifier (loaded via a test-relative path);
// override only the DB lookup. The route imports these from "~/lib/…", an alias
// only the mock registry resolves here, so the whole module must be mocked.
vi.mock("~/lib/github-webhook.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/github-webhook.server")>(
    "../../lib/github-webhook.server",
  );
  return { ...actual, findDocoByInstallation, findDocoTargetsForGitHubRepo };
});

import { action } from "../api.github.webhook";

const SECRET = "whsec";
const send = (event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return action({
    request: new Request("https://doco.to/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": signature,
      },
      body,
    }),
  });
};

beforeEach(() => {
  process.env.DOCO_GITHUB_WEBHOOK_SECRET = SECRET;
  vi.clearAllMocks();
});
afterEach(() => {
  process.env.DOCO_GITHUB_WEBHOOK_SECRET = undefined;
});

describe("api.github.webhook action — uninstall / repo-removed / review", () => {
  it("rejects an invalid signature with 401", async () => {
    const res = await action({
      request: new Request("https://doco.to/api/github/webhook", {
        method: "POST",
        headers: { "x-github-event": "installation", "x-hub-signature-256": "sha256=bad" },
        body: "{}",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("installation deleted → detaches the installation everywhere", async () => {
    const res = await send("installation", { action: "deleted", installation: { id: 7 } });
    expect(await res.json()).toMatchObject({ ok: true, detached: 7 });
    expect(unsubscribeInstallationEverywhere).toHaveBeenCalledWith(7);
  });

  it("installation created → ignored (no detach)", async () => {
    const res = await send("installation", { action: "created", installation: { id: 7 } });
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(unsubscribeInstallationEverywhere).not.toHaveBeenCalled();
  });

  it("installation_repositories removed → detaches those repos", async () => {
    const res = await send("installation_repositories", {
      action: "removed",
      installation: { id: 42 },
      repositories_removed: [{ full_name: "acme/old" }],
    });
    expect(await res.json()).toMatchObject({ ok: true, removed: 1 });
    expect(detachReposEverywhere).toHaveBeenCalledWith(["acme/old"]);
    expect(backfillInstallationRepos).not.toHaveBeenCalled();
  });

  it("installation_repositories added → records the connection AND backfills", async () => {
    const res = await send("installation_repositories", {
      action: "added",
      installation: { id: 42 },
      repositories_added: [{ full_name: "acme/new" }],
    });
    expect(await res.json()).toMatchObject({ ok: true, added: 1 });
    // The new repo is recorded as a connection (so it shows on the page)…
    expect(addConnection).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ repo: "acme/new", installation_id: 42 }),
    );
    // …and its pre-existing items are backfilled, as what the Doco brings.
    expect(backfillInstallationRepos).toHaveBeenCalledTimes(1);
    expect(backfillInstallationRepos).toHaveBeenCalledWith(
      expect.objectContaining({ docoId: "doco_1", template: "bugs", repos: ["acme/new"] }),
    );
    expect(detachReposEverywhere).not.toHaveBeenCalled();
  });

  it("pull_request_review approved → upserts the PR with approved:true", async () => {
    const res = await send("pull_request_review", {
      action: "submitted",
      review: { state: "approved" },
      repository: { full_name: "acme/store" },
      installation: { id: 99 },
      pull_request: {
        number: 5,
        title: "t",
        html_url: "https://github.com/acme/store/pull/5",
        state: "open",
      },
    });
    expect(await res.json()).toMatchObject({ ok: true, repo: "acme/store" });
    expect(findDocoTargetsForGitHubRepo).toHaveBeenCalledWith(
      99,
      "acme/store",
      "github-pull-requests",
    );
    expect(upsertPullRequestReference).toHaveBeenCalledWith(
      expect.objectContaining({ number: 5 }),
      expect.objectContaining({ approved: true, docoId: "doco_1" }),
    );
  });

  it("pull_request sync passes changed files when the Doco has code references", async () => {
    hasBusinessProcessCodeReferences.mockResolvedValueOnce(true);
    listPullRequestFiles.mockResolvedValueOnce([
      {
        filename: "packages/web/app/lib/github-pr-import.server.ts",
        patch: "@@ -1,1 +1,2 @@\n x\n+y",
      },
    ]);
    const res = await send("pull_request", {
      action: "opened",
      repository: { full_name: "acme/store" },
      installation: { id: 99 },
      pull_request: {
        number: 5,
        title: "t",
        html_url: "https://github.com/acme/store/pull/5",
        state: "open",
      },
    });
    expect(await res.json()).toMatchObject({ ok: true, repo: "acme/store" });
    expect(findDocoTargetsForGitHubRepo).toHaveBeenCalledWith(
      99,
      "acme/store",
      "github-pull-requests",
    );
    expect(mintInstallationToken).toHaveBeenCalledWith(99);
    expect(listPullRequestFiles).toHaveBeenCalledWith("ghs_test", "acme", "store", 5);
    expect(upsertPullRequestReference).toHaveBeenCalledWith(
      expect.objectContaining({ number: 5 }),
      expect.objectContaining({
        docoId: "doco_1",
        changedFiles: [
          {
            filename: "packages/web/app/lib/github-pr-import.server.ts",
            patch: "@@ -1,1 +1,2 @@\n x\n+y",
          },
        ],
      }),
    );
  });

  it("pull_request_review commented → ignored (not an approval)", async () => {
    const res = await send("pull_request_review", {
      action: "submitted",
      review: { state: "commented" },
      repository: { full_name: "acme/store" },
      installation: { id: 99 },
      pull_request: {
        number: 5,
        title: "t",
        html_url: "https://github.com/acme/store/pull/5",
        state: "open",
      },
    });
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(upsertPullRequestReference).not.toHaveBeenCalled();
  });

  it("issues → files the issue in the Bug trackers that bring bugs from the repo", async () => {
    const issue = {
      number: 7,
      title: "Login fails",
      html_url: "https://github.com/acme/store/issues/7",
      state: "open",
      labels: [{ name: "bug" }],
    };
    const res = await send("issues", {
      action: "labeled",
      repository: { full_name: "acme/store" },
      installation: { id: 99 },
      issue,
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      repo: "acme/store",
      results: [{ doco: "store", status: "created" }],
    });
    expect(findDocoTargetsForGitHubRepo).toHaveBeenCalledWith(99, "acme/store", "bugs");
    expect(syncBugIssue).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7 }),
      expect.objectContaining({ docoId: "doco_1", docoSlug: "store", deleted: false }),
    );
  });

  it("issues deleted → retires the bug the issue filed", async () => {
    await send("issues", {
      action: "deleted",
      repository: { full_name: "acme/store" },
      installation: { id: 99 },
      issue: { number: 7, title: "x", html_url: "https://github.com/acme/store/issues/7" },
    });
    expect(syncBugIssue).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7 }),
      expect.objectContaining({ deleted: true }),
    );
  });

  it("push to the default branch → brings the new code into the codebase Docos", async () => {
    const res = await send("push", {
      ref: "refs/heads/main",
      repository: { full_name: "acme/store", default_branch: "main" },
      installation: { id: 99 },
    });
    expect(await res.json()).toMatchObject({ ok: true, repo: "acme/store", syncing: ["store"] });
    expect(findDocoTargetsForGitHubRepo).toHaveBeenCalledWith(99, "acme/store", "codebase");
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];
    expect(syncRepoCodebase).toHaveBeenCalledWith(
      expect.objectContaining({
        docoId: "doco_1",
        owner: "acme",
        repo: "store",
        installationId: 99,
      }),
    );
  });

  it("push to another branch → ignored", async () => {
    const res = await send("push", {
      ref: "refs/heads/feature",
      repository: { full_name: "acme/store", default_branch: "main" },
      installation: { id: 99 },
    });
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(findDocoTargetsForGitHubRepo).not.toHaveBeenCalled();
    expect(syncRepoCodebase).not.toHaveBeenCalled();
  });
});
