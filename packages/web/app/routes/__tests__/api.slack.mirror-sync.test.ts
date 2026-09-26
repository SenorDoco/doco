import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActiveSlackMirrors: vi.fn(),
  runSlackMirrorTick: vi.fn(),
  getSlackBotToken: vi.fn(),
}));

vi.mock("~/lib/slack-mirror-sync.server", () => ({
  listActiveSlackMirrors: mocks.listActiveSlackMirrors,
  runSlackMirrorTick: mocks.runSlackMirrorTick,
}));
vi.mock("~/lib/slack.server", () => ({ getSlackBotToken: mocks.getSlackBotToken }));

import { action } from "../api.slack.mirror-sync";

const SECRET = "cron-secret";
const req = (headers: Record<string, string> = {}) =>
  new Request("https://doco.test/api/slack/mirror-sync", { method: "POST", headers });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.listActiveSlackMirrors.mockResolvedValue([
    { docoId: "doco_a", teamId: "TA" },
    { docoId: "doco_b", teamId: "TB" },
  ]);
  mocks.getSlackBotToken.mockImplementation(async (team: string) => `xoxb-${team}`);
  mocks.runSlackMirrorTick.mockResolvedValue({
    channelsSynced: false,
    historyCalls: 1,
    repliesCalls: 1,
    rateLimited: false,
  });
});
afterEach(() => {
  process.env.CRON_SECRET = undefined;
  process.env.DOCO_SLACK_MIRROR_CALLS_PER_MINUTE = undefined;
});

describe("/api/slack/mirror-sync", () => {
  it("403s without Vercel Cron's bearer secret, even with the x-vercel-cron header", async () => {
    expect((await action({ request: req() })).status).toBe(403);
    expect((await action({ request: req({ "x-vercel-cron": "1" }) })).status).toBe(403);
    expect(mocks.runSlackMirrorTick).not.toHaveBeenCalled();
  });

  it("advances every mirror's sync with its team's bot token", async () => {
    const res = await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });

    expect(res.status).toBe(200);
    expect(mocks.runSlackMirrorTick.mock.calls).toEqual([
      [{ docoId: "doco_a", token: "xoxb-TA", callsPerMinute: 1 }],
      [{ docoId: "doco_b", token: "xoxb-TB", callsPerMinute: 1 }],
    ]);
  });

  it("uses a higher per-minute call budget when configured (Marketplace-approved app)", async () => {
    process.env.DOCO_SLACK_MIRROR_CALLS_PER_MINUTE = "40";
    await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });
    expect(mocks.runSlackMirrorTick).toHaveBeenCalledWith(
      expect.objectContaining({ callsPerMinute: 40 }),
    );
  });

  it("keeps going when one mirror's sync fails", async () => {
    mocks.runSlackMirrorTick.mockRejectedValueOnce(new Error("slack down"));

    const res = await action({ request: req({ Authorization: `Bearer ${SECRET}` }) });

    expect(res.status).toBe(200);
    expect(mocks.runSlackMirrorTick).toHaveBeenCalledTimes(2);
    await expect(res.json()).resolves.toMatchObject({
      mirrors: [
        { docoId: "doco_a", error: "slack down" },
        { docoId: "doco_b", historyCalls: 1 },
      ],
    });
  });
});
