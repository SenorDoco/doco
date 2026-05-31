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
    const upsert = vi.fn(async () => ({ id: "reference_x" }));

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
      upsert: upsert as never,
    });

    expect(res).toEqual({ total: 3, imported: 3, failed: 0 });
    expect(mintToken).toHaveBeenCalledWith(42);
    expect(listPrs).toHaveBeenCalledWith("ghs_x", "acme", "store");
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ docoId: "doco_1", docoDir: "/tmp/d" }),
    );
  });

  it("counts upsert failures without aborting the run", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listPrs = vi.fn(async () => [pr(1), pr(2)]);
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ error: "boom" })
      .mockResolvedValueOnce({ id: "reference_ok" });

    const res = await backfillRepoPullRequests(opts, {
      mintToken: mintToken as never,
      listPrs: listPrs as never,
      upsert: upsert as never,
    });

    expect(res).toEqual({ total: 2, imported: 1, failed: 1 });
  });
});
