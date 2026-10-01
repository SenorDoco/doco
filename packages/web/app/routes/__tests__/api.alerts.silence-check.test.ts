import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkSilences: vi.fn(),
  emailNewAlerts: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn("client") }));
vi.mock("~/lib/silence-alerts.server", () => ({
  checkSilences: mocks.checkSilences,
  emailNewAlerts: mocks.emailNewAlerts,
}));

import { loader } from "../api.alerts.silence-check";

function call(headers: Record<string, string> = {}) {
  return loader({
    request: new Request("https://doco.vercel.app/api/alerts/silence-check", { headers }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("DOCO_PUBLIC_HOST", "");
  mocks.checkSilences.mockResolvedValue({ opened: 1, closed: 2, open: 3 });
  mocks.emailNewAlerts.mockResolvedValue({ emailed: 1, emails: 2 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/alerts/silence-check", () => {
  it("only answers Vercel Cron's bearer", async () => {
    expect((await call()).status).toBe(403);
    expect((await call({ "x-vercel-cron": "1" })).status).toBe(403);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(403);
    expect(mocks.checkSilences).not.toHaveBeenCalled();
  });

  // Links in the emails point at the public site, not the host the cron hit.
  it("checks every source and agent, then emails the new alerts", async () => {
    const res = await call({ authorization: "Bearer cron-secret" });
    expect(await res.json()).toEqual({
      ok: true,
      opened: 1,
      closed: 2,
      open: 3,
      emailed: 1,
      emails: 2,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.checkSilences).toHaveBeenCalledWith("client");
    expect(mocks.emailNewAlerts).toHaveBeenCalledWith("client", "https://doco.to");
  });
});
