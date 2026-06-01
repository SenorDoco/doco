import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoByIdOrHandle: vi.fn(),
  getDocoLevelRole: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  getInstallationAccount: vi.fn(),
  importInstallationConnections: vi.fn(),
  kickBackfillRun: vi.fn(),
  setBackfillState: vi.fn(),
  subscribeInstallation: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, writer: 2, owner: 3 } as const;
  return {
    getDocoByIdOrHandle: mocks.getDocoByIdOrHandle,
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
  };
});

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationAccount: mocks.getInstallationAccount,
}));

vi.mock("~/lib/github-connection.server", () => ({
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  importInstallationConnections: mocks.importInstallationConnections,
  setBackfillState: mocks.setBackfillState,
  subscribeInstallation: mocks.subscribeInstallation,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

vi.mock("../api.github.backfill-run", () => ({
  kickBackfillRun: mocks.kickBackfillRun,
}));

import { loader } from "../api.github.setup";

function setupRequest(params = "installation_id=42&state=doco_1"): Request {
  return new Request(`https://doco.test/api/github/setup?${params}`);
}

describe("api.github.setup loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocoByIdOrHandle.mockResolvedValue({
      id: "doco_1",
      handle: "prs",
      owner_id: "organization_1",
    });
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_1" });
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "prs",
      orgHandle: "doco",
      connections: [],
      installations: [],
      backfill: null,
    });
    mocks.getInstallationAccount.mockResolvedValue({ account: "acme" });
    mocks.importInstallationConnections.mockResolvedValue({ repos: [] });
    mocks.kickBackfillRun.mockResolvedValue(undefined);
    mocks.setBackfillState.mockResolvedValue(undefined);
    mocks.subscribeInstallation.mockResolvedValue([]);
  });

  it("records the installation subscription even when GitHub returns no repos", async () => {
    const response = await loader({ request: setupRequest() });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/prs/integrations/github?github=connected&count=0&imported=0",
    );
    expect(mocks.getInstallationAccount).toHaveBeenCalledWith(42);
    expect(mocks.subscribeInstallation).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({
        installation_id: 42,
        account: "acme",
        connected_at: expect.any(String),
      }),
    );
    expect(mocks.importInstallationConnections).toHaveBeenCalledWith({
      docoId: "doco_1",
      installationId: 42,
    });
  });

  it("records the installation before starting the repo backfill", async () => {
    mocks.importInstallationConnections.mockResolvedValue({ repos: ["acme/app"] });

    const response = await loader({ request: setupRequest() });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/prs/integrations/github?github=importing&count=1",
    );
    expect(mocks.subscribeInstallation).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ installation_id: 42, account: "acme" }),
    );
    expect(mocks.setBackfillState).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({
        status: "running",
        repos: 1,
        installation_id: 42,
        queue: ["acme/app"],
      }),
    );
    expect(mocks.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
