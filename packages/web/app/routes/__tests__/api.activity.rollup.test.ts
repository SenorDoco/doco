import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rollUpActivity: vi.fn() }));

vi.mock("@doco/db", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn("client") }));
vi.mock("~/lib/activity-log.server", () => ({ rollUpActivity: mocks.rollUpActivity }));

import { loader } from "../api.activity.rollup";

function call(headers: Record<string, string> = {}) {
  return loader({
    request: new Request("https://doco.vercel.app/api/activity/rollup", { headers }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.rollUpActivity.mockResolvedValue({ through: "2026-09-05" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/activity/rollup", () => {
  it("only answers Vercel Cron's bearer", async () => {
    expect((await call()).status).toBe(403);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(403);
    expect(mocks.rollUpActivity).not.toHaveBeenCalled();
  });

  it("rolls up the activity logs in one transaction", async () => {
    const res = await call({ authorization: "Bearer cron-secret" });
    expect(await res.json()).toEqual({ ok: true, through: "2026-09-05" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rollUpActivity).toHaveBeenCalledWith("client");
  });
});
