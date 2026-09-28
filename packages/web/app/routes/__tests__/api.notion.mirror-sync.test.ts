import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActiveNotionMirrors: vi.fn(),
  runNotionMirrorTick: vi.fn(),
}));

vi.mock("~/lib/notion-mirror-sync.server", () => ({
  DEFAULT_REQUESTS_PER_MINUTE: 120,
  listActiveNotionMirrors: mocks.listActiveNotionMirrors,
  runNotionMirrorTick: mocks.runNotionMirrorTick,
}));

import { action } from "../api.notion.mirror-sync";

const SECRET = "cron-secret";
const req = (headers: Record<string, string> = {}) =>
  new Request("https://doco.test/api/notion/mirror-sync", { method: "POST", headers });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  mocks.listActiveNotionMirrors.mockResolvedValue([{ docoId: "doco_a" }, { docoId: "doco_b" }]);
  mocks.runNotionMirrorTick.mockResolvedValue({ discovery: "none", fetched: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/notion/mirror-sync", () => {
  it("403s without Vercel Cron's bearer secret, even with the x-vercel-cron header", async () => {
    expect((await action({ request: req() })).status).toBe(403);
    expect((await action({ request: req({ "x-vercel-cron": "1" }) })).status).toBe(403);
    expect(mocks.runNotionMirrorTick).not.toHaveBeenCalled();
  });

  it("advances every mirror's sync at the default request budget", async () => {
    const res = await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });

    expect(res.status).toBe(200);
    expect(mocks.runNotionMirrorTick.mock.calls).toEqual([
      [{ docoId: "doco_a", requestsPerMinute: 120 }],
      [{ docoId: "doco_b", requestsPerMinute: 120 }],
    ]);
  });

  it("uses a higher budget when configured (a Business or Enterprise workspace)", async () => {
    vi.stubEnv("DOCO_NOTION_MIRROR_CALLS_PER_MINUTE", "500");
    await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });
    expect(mocks.runNotionMirrorTick).toHaveBeenCalledWith(
      expect.objectContaining({ requestsPerMinute: 500 }),
    );
  });

  it("keeps going when one mirror's sync fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runNotionMirrorTick.mockRejectedValueOnce(new Error("notion down"));

    const res = await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      mirrors: [
        { docoId: "doco_a", error: "notion down" },
        { docoId: "doco_b", fetched: 1 },
      ],
    });
    error.mockRestore();
  });
});
