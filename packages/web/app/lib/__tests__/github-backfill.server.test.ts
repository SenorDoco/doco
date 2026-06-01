import { describe, expect, it, vi } from "vitest";

// The module under test imports github-app + github-pr-import, which import
// @doco/db; mock it so the import resolves without a real DB.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { backfillInstallationRepos, backfillRepoPullRequests } from "../github-backfill.server";

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
    const listPrs = vi.fn(async () => ({ prs: [pr(1), pr(2), pr(3)], hasMore: false }));
    const upsert = vi.fn(async () => ({ status: "created", id: "reference_x" }));

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
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
    const listPrs = vi.fn(async () => ({ prs: [pr(1), pr(2), pr(3), pr(4)], hasMore: false }));
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ status: "error", error: "boom" })
      .mockResolvedValueOnce({ status: "created", id: "r1" })
      .mockResolvedValueOnce({ status: "unchanged", id: "r2" })
      .mockResolvedValueOnce({ status: "updated", id: "r3" });

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
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
    const listPrs = vi.fn(async () => ({ prs: [pr(1), pr(2)], hasMore: true }));
    const upsert = vi.fn(async () => ({ status: "created", id: "r1" }));

    const res = await backfillRepoPullRequests(
      { ...opts, startPage: 1, pagesPerBatch: 5 },
      { mintToken: mintToken as never, listPrs: listPrs as never, upsert: upsert as never },
    );

    expect(res.nextPage).toBe(6);
  });

  it("passes startPage to listPrs for cursor-based continuation", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => ({ prs: [pr(501)], hasMore: false }));
    const upsert = vi.fn(async () => ({ status: "unchanged", id: "r1" }));

    await backfillRepoPullRequests(
      { ...opts, startPage: 6, pagesPerBatch: 5 },
      { mintToken: mintToken as never, listPrs: listPrs as never, upsert: upsert as never },
    );

    expect(listPrs).toHaveBeenCalledWith("t", "acme", "store", { startPage: 6, maxPages: 5 });
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
        repos: ["acme/a", "bogus"],
        installationId: 1,
      },
      { backfillRepo: backfillRepo as never },
    );
    expect(res.repos).toBe(1);
    expect(backfillRepo).toHaveBeenCalledTimes(1);
  });
});
