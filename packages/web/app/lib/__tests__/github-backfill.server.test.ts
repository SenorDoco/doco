import { describe, expect, it, vi } from "vitest";

// The module under test imports github-app + github-pr-import, which import
// @doco/db; mock it so the import resolves without a real DB.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { backfillRepoCodebase } from "../codebase-sync.server";
import {
  backfillRepoIssues,
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

describe("backfillRepoIssues", () => {
  const issue = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `Issue ${n}`,
    html_url: `https://github.com/acme/store/issues/${n}`,
    state: "open" as const,
    ...extra,
  });

  it("files every issue from a window of the repo's issues, passing over pull requests", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listIssues = vi.fn(async () => ({
      items: [issue(1), issue(2), issue(3, { pull_request: {} }), issue(4)],
      hasMore: true,
    }));
    const sync = vi
      .fn()
      .mockResolvedValueOnce({ status: "created", id: "eval_1" })
      .mockResolvedValueOnce({ status: "updated", id: "eval_2" })
      .mockResolvedValueOnce({ status: "unchanged", id: "eval_4" });

    const res = await backfillRepoIssues(
      { ...opts, startPage: 6 },
      { mintToken: mintToken as never, listIssues: listIssues as never, sync: sync as never },
    );

    expect(listIssues).toHaveBeenCalledWith("t", "acme", "store", { startPage: 6, maxPages: 5 });
    expect(sync.mock.calls.map(([i]) => i.number)).toEqual([1, 2, 4]);
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ docoId: "doco_1", docoSlug: "d" }),
    );
    expect(res).toEqual({
      total: 3,
      created: 1,
      updated: 1,
      unchanged: 1,
      failed: 0,
      nextPage: 11,
    });
  });
});

describe("repoBackfillFor", () => {
  it("walks issues for a GitHub issues Doco, files for a codebase and pull requests for any other Doco", () => {
    expect(repoBackfillFor("github-issues")).toBe(backfillRepoIssues);
    expect(repoBackfillFor("codebase")).toBe(backfillRepoCodebase);
    expect(repoBackfillFor("github-pull-requests")).toBe(backfillRepoPullRequests);
    expect(repoBackfillFor(null)).toBe(backfillRepoPullRequests);
  });
});
