import { describe, expect, it, vi } from "vitest";

// The module under test imports github-app + github-pr-import, which import
// @doco/db; mock it so the import resolves without a real DB.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { backfillRepoPullRequests } from "../github-backfill.server";

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
    const listPrs = vi.fn(async () => [pr(1), pr(2), pr(3)]);
    const upsert = vi.fn(async () => ({ status: "created", id: "reference_x" }));

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
      upsert: upsert as never,
    });

    expect(res).toEqual({ total: 3, created: 3, updated: 0, unchanged: 0, failed: 0 });
    expect(mintToken).toHaveBeenCalledWith(42);
    expect(listPrs).toHaveBeenCalledWith("ghs_x", "acme", "store");
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ docoId: "doco_1", docoDir: "/tmp/d" }),
    );
  });

  it("classifies created / updated / unchanged / failed without aborting", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => [pr(1), pr(2), pr(3), pr(4)]);
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

    expect(res).toEqual({ total: 4, created: 1, updated: 1, unchanged: 1, failed: 1 });
  });
});
