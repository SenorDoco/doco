// The admin cron endpoints trust only `Authorization: Bearer <CRON_SECRET>`
// (which Vercel Cron sends when CRON_SECRET is set) or a signed-in admin. The
// `x-vercel-cron` header is not proof of anything — any client can set it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  purgeDocosDeletedBefore: vi.fn(),
  getAgentHealth: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("@doco/db", () => ({ purgeDocosDeletedBefore: mocks.purgeDocosDeletedBefore }));
vi.mock("~/lib/agent-health.server", () => ({ getAgentHealth: mocks.getAgentHealth }));

import { loader as agentHealthLoader } from "../admin.agent-health-cron";
import { loader as purgeLoader } from "../admin.purge-deleted-docos";

const SECRET = "cron-secret";
const req = (path: string, headers: Record<string, string>) =>
  new Request(`https://doco.test${path}`, { headers });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.getCurrentPrincipal.mockResolvedValue(null);
  mocks.purgeDocosDeletedBefore.mockResolvedValue([]);
  mocks.getAgentHealth.mockResolvedValue({ status: "ok", signals: [] });
});
afterEach(() => {
  process.env.CRON_SECRET = undefined;
});

describe.each([
  ["/admin/purge-deleted-docos", purgeLoader, mocks.purgeDocosDeletedBefore],
  ["/admin/agent-health-cron", agentHealthLoader, mocks.getAgentHealth],
] as const)("%s", (path, loader, work) => {
  it("runs for Vercel Cron's bearer secret", async () => {
    const res = await loader({ request: req(path, { Authorization: `Bearer ${SECRET}` }) });
    expect(res.status).toBe(200);
    expect(work).toHaveBeenCalled();
  });

  it("does not run for a request carrying only the x-vercel-cron header", async () => {
    await expect(loader({ request: req(path, { "x-vercel-cron": "1" }) })).rejects.toBeInstanceOf(
      Response,
    );
    expect(work).not.toHaveBeenCalled();
  });
});
