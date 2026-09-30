import { describe, expect, it, vi } from "vitest";

// The module under test imports github-app + github-pr-import, which import
// @doco/db; mock it so the import resolves without a real DB.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { backfillRepoCodebase } from "../codebase-sync.server";
import {
  backfillInstallationRepos,
  backfillRepoBugs,
  backfillRepoPullRequests,
  repoBackfillFor,
} from "../github-backfill.server";

const opts = {
  docoDir: "/tmp/d",
  docoId: "doco_1",
  ownerSlug: "o",
  docoSlug: "d",
  owner: "acme",
  repo: "store",
  installationId: 42,
};
const pr = (n: number) =>
  ({
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/acme/store/pull/${n}`,
    state: "open" as const,
  }) as const;

describe("backfillRepoPullRequests", () => {
  it("mints a token, lists the repo's PRs, and upserts each", async () => {
    const mintToken = vi.fn(async () => ({ token: "ghs_x", expires_at: "" }));
    const listPrs = vi.fn(async () => ({ items: [pr(1), pr(2), pr(3)], hasMore: false }));
    const hasCodeReferences = vi.fn(async () => false);
    const upsert = vi.fn(async () => ({ status: "created", id: "reference_x" }));

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
      hasCodeReferences: hasCodeReferences as never,
      upsert: upsert as never,
    });

    expect(res).toEqual({
      total: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
      nextPage: null,
    });
    expect(mintToken).toHaveBeenCalledWith(42);
    expect(listPrs).toHaveBeenCalledWith("ghs_x", "acme", "store", { startPage: 1, maxPages: 5 });
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ docoId: "doco_1", docoDir: "/tmp/d" }),
    );
  });

  it("classifies created / updated / unchanged / failed without aborting", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => ({ items: [pr(1), pr(2), pr(3), pr(4)], hasMore: false }));
    const hasCodeReferences = vi.fn(async () => false);
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ status: "error", error: "boom" })
      .mockResolvedValueOnce({ status: "created", id: "r1" })
      .mockResolvedValueOnce({ status: "unchanged", id: "r2" })
      .mockResolvedValueOnce({ status: "updated", id: "r3" });

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
      hasCodeReferences: hasCodeReferences as never,
      upsert: upsert as never,
    });

    expect(res).toEqual({
      total: 4,
      created: 1,
      updated: 1,
      unchanged: 1,
      failed: 1,
      nextPage: null,
    });
  });

  it("returns nextPage when hasMore is true", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => ({ items: [pr(1), pr(2)], hasMore: true }));
    const hasCodeReferences = vi.fn(async () => false);
    const upsert = vi.fn(async () => ({ status: "created", id: "r1" }));

    const res = await backfillRepoPullRequests(
      { ...opts, startPage: 1, pagesPerBatch: 5 },
      {
        mintToken: mintToken as never,
        listPrs: listPrs as never,
        hasCodeReferences: hasCodeReferences as never,
        upsert: upsert as never,
      },
    );

    expect(res.nextPage).toBe(6);
  });

  it("passes startPage to listPrs for cursor-based continuation", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => ({ items: [pr(501)], hasMore: false }));
    const hasCodeReferences = vi.fn(async () => false);
    const upsert = vi.fn(async () => ({ status: "unchanged", id: "r1" }));

    await backfillRepoPullRequests(
      { ...opts, startPage: 6, pagesPerBatch: 5 },
      {
        mintToken: mintToken as never,
        listPrs: listPrs as never,
        hasCodeReferences: hasCodeReferences as never,
        upsert: upsert as never,
      },
    );

    expect(listPrs).toHaveBeenCalledWith("t", "acme", "store", { startPage: 6, maxPages: 5 });
  });

  it("loads PR files and passes changedFiles when code references exist", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => ({ items: [pr(1)], hasMore: false }));
    const hasCodeReferences = vi.fn(async () => true);
    const listFiles = vi.fn(async () => [
      {
        filename: "packages/web/app/lib/github-pr-import.server.ts",
        patch: "@@ -1,1 +1,2 @@\n x\n+y",
      },
    ]);
    const upsert = vi.fn(async () => ({ status: "updated", id: "r1" }));

    await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
      hasCodeReferences: hasCodeReferences as never,
      listFiles: listFiles as never,
      upsert: upsert as never,
    });

    expect(listFiles).toHaveBeenCalledWith("t", "acme", "store", 1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({
        changedFiles: [
          {
            filename: "packages/web/app/lib/github-pr-import.server.ts",
            patch: "@@ -1,1 +1,2 @@\n x\n+y",
          },
        ],
      }),
    );
  });
});

describe("backfillRepoBugs", () => {
  const issue = (n: number, labels: string[], extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `Issue ${n}`,
    html_url: `https://github.com/acme/store/issues/${n}`,
    state: "open" as const,
    labels: labels.map((name) => ({ name })),
    ...extra,
  });

  it("files only the bug issues from a window of the repo's issues", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listIssues = vi.fn(async () => ({
      items: [
        issue(1, ["bug"]),
        issue(2, ["enhancement"]),
        issue(3, ["bug"], { pull_request: {} }),
        issue(4, ["type: bug"]),
      ],
      hasMore: true,
    }));
    const sync = vi
      .fn()
      .mockResolvedValueOnce({ status: "created", id: "eval_1" })
      .mockResolvedValueOnce({ status: "unchanged", id: "eval_4" });

    const res = await backfillRepoBugs(
      { ...opts, startPage: 6 },
      { mintToken: mintToken as never, listIssues: listIssues as never, sync: sync as never },
    );

    expect(listIssues).toHaveBeenCalledWith("t", "acme", "store", { startPage: 6, maxPages: 5 });
    expect(sync.mock.calls.map(([i]) => i.number)).toEqual([1, 4]);
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ docoId: "doco_1", docoSlug: "d" }),
    );
    expect(res).toEqual({
      total: 2,
      created: 1,
      updated: 0,
      unchanged: 1,
      failed: 0,
      nextPage: 11,
    });
  });
});

describe("repoBackfillFor", () => {
  it("walks bugs for a GitHub bugs Doco, files for a codebase and pull requests for any other Doco", () => {
    expect(repoBackfillFor("github-bugs")).toBe(backfillRepoBugs);
    expect(repoBackfillFor("codebase")).toBe(backfillRepoCodebase);
    expect(repoBackfillFor("github-pull-requests")).toBe(backfillRepoPullRequests);
    expect(repoBackfillFor(null)).toBe(backfillRepoPullRequests);
  });
});

describe("backfillInstallationRepos", () => {
  it("backfills every repo the installation covers and aggregates the tally", async () => {
    const backfillRepo = vi
      .fn()
      .mockResolvedValueOnce({
        total: 2,
        created: 2,
        updated: 0,
        unchanged: 0,
        failed: 0,
        nextPage: null,
      })
      .mockResolvedValueOnce({
        total: 3,
        created: 1,
        updated: 1,
        unchanged: 1,
        failed: 0,
        nextPage: null,
      });
    const res = await backfillInstallationRepos(
      {
        docoDir: "/tmp/d",
        docoId: "doco_1",
        ownerSlug: "o",
        docoSlug: "d",
        template: "github-pull-requests",
        repos: ["acme/a", "acme/b"],
        installationId: 42,
        createdByUserId: "u",
      },
      { backfillRepo: backfillRepo as never },
    );
    expect(res).toEqual({ repos: 2, created: 3, updated: 1, unchanged: 1, failed: 0 });
    expect(backfillRepo).toHaveBeenCalledTimes(2);
    expect(backfillRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "a", installationId: 42, docoId: "doco_1" }),
    );
  });

  it("skips malformed repo full-names", async () => {
    const backfillRepo = vi.fn().mockResolvedValue({
      total: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      nextPage: null,
    });
    const res = await backfillInstallationRepos(
      {
        docoDir: "/tmp/d",
        docoId: "doco_1",
        ownerSlug: "o",
        docoSlug: "d",
        template: null,
        repos: ["acme/a", "bogus"],
        installationId: 1,
      },
      { backfillRepo: backfillRepo as never },
    );
    expect(res.repos).toBe(1);
    expect(backfillRepo).toHaveBeenCalledTimes(1);
  });
});
