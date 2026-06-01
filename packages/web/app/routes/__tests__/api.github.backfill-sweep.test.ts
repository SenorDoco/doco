import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const { findStaleRunningBackfills } = vi.hoisted(() => ({ findStaleRunningBackfills: vi.fn() }));
vi.mock("~/lib/github-connection.server", () => ({ findStaleRunningBackfills }));

import { waitUntil } from "@vercel/functions";
import { action } from "../api.github.backfill-sweep";

const SECRET = "shhh";
const req = (headers: Record<string, string> = {}) =>
  new Request("https://doco.to/api/github/backfill-sweep", { method: "POST", headers });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.DOCO_GITHUB_WEBHOOK_SECRET = undefined;
  findStaleRunningBackfills.mockReset();
  (waitUntil as unknown as ReturnType<typeof vi.fn>).mockReset();
  global.fetch = vi.fn(async () => new Response("{}")) as never;
});
afterEach(() => {
  process.env.CRON_SECRET = undefined;
});

describe("api.github.backfill-sweep", () => {
  it("403s without the bearer secret or cron header", async () => {
    const res = await action({ request: req() });
    expect(res.status).toBe(403);
    expect(findStaleRunningBackfills).not.toHaveBeenCalled();
  });

  it("re-kicks each stranded backfill and reports the count", async () => {
    findStaleRunningBackfills.mockResolvedValue(["doco_1", "doco_2"]);
    const res = await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });
    expect(await res.json()).toEqual({ ok: true, swept: 2, doco_ids: ["doco_1", "doco_2"] });
    expect(waitUntil).toHaveBeenCalledTimes(2);
    // Each re-kick POSTs the worker with the bearer secret.
    expect(global.fetch).toHaveBeenCalledWith(
      "https://doco.to/api/github/backfill-run",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${SECRET}` }),
      }),
    );
  });

  it("queries with a staleness cutoff in the past and is a no-op when none are stale", async () => {
    findStaleRunningBackfills.mockResolvedValue([]);
    const res = await action({ request: req({ "x-vercel-cron": "1" }) });
    expect(await res.json()).toEqual({ ok: true, swept: 0, doco_ids: [] });
    const cutoff = findStaleRunningBackfills.mock.calls[0][0] as string;
    expect(new Date(cutoff).getTime()).toBeLessThan(Date.now());
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
