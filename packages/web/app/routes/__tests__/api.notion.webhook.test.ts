import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mirrorNotionEvent: vi.fn(),
  runNotionMirrorTick: vi.fn(),
  waitUntil: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("~/lib/notion-mirror.server", () => ({ mirrorNotionEvent: mocks.mirrorNotionEvent }));
vi.mock("~/lib/notion-mirror-sync.server", () => ({
  runNotionMirrorTick: mocks.runNotionMirrorTick,
}));

import { action } from "../api.notion.webhook";

const SECRET = "secret_verification_token";
const event = {
  id: "evt_1",
  type: "page.content_updated",
  workspace_id: "ws1",
  entity: { id: "p1", type: "page" },
  accessible_by: [{ id: "bot1", type: "bot" }],
};

function deliver(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return action({
    request: new Request("https://doco.test/api/notion/webhook", {
      method: "POST",
      headers,
      body: raw,
    }),
  });
}

function signed(body: unknown, secret = SECRET) {
  return {
    "x-notion-signature": `sha256=${createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex")}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCO_NOTION_WEBHOOK_SECRET", SECRET);
  mocks.mirrorNotionEvent.mockResolvedValue({ docoIds: ["doco_notion"] });
  mocks.runNotionMirrorTick.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/notion/webhook", () => {
  it("only takes POST", async () => {
    const res = await action({
      request: new Request("https://doco.test/api/notion/webhook", { method: "GET" }),
    });
    expect(res.status).toBe(405);
  });

  it("answers the subscription handshake, which carries no signature", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await deliver({ verification_token: "secret_new" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handshake: true });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("secret_new"));
    expect(mocks.mirrorNotionEvent).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("rejects an unsigned or badly signed delivery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await deliver(event)).status).toBe(401);
    expect((await deliver(event, signed(event, "other"))).status).toBe(401);
    expect(mocks.mirrorNotionEvent).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("applies a signed event, reports the mirrors it reached, and kicks their sync", async () => {
    const res = await deliver(event, signed(event));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: 1 });
    expect(mocks.mirrorNotionEvent).toHaveBeenCalledWith(event);
    expect(mocks.runNotionMirrorTick).toHaveBeenCalledWith({
      docoId: "doco_notion",
      deadlineMs: 20_000,
    });
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when the mirror write fails, so Notion redelivers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.mirrorNotionEvent.mockRejectedValueOnce(new Error("db down"));

    expect((await deliver(event, signed(event))).status).toBe(500);
    error.mockRestore();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await action({
      request: new Request("https://doco.test/api/notion/webhook", {
        method: "POST",
        body: "not json",
      }),
    });
    expect(res.status).toBe(400);
  });
});
