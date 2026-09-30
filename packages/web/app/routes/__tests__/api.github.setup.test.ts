import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoByIdOrHandle: vi.fn(),
  getDocoLevelRole: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  getInstallationAccount: vi.fn(),
  exchangeInstallationCode: vi.fn(),
  listUserInstallationIds: vi.fn(),
  importInstallationConnections: vi.fn(),
  kickBackfillRun: vi.fn(),
  recordInstallationAuthorization: vi.fn(),
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
  exchangeInstallationCode: mocks.exchangeInstallationCode,
  listUserInstallationIds: mocks.listUserInstallationIds,
}));

vi.mock("~/lib/github-connection.server", async (importOriginal) => ({
  // The real state signer/verifier: the route must reject anything it didn't sign.
  signInstallState: (await importOriginal<typeof import("~/lib/github-connection.server")>())
    .signInstallState,
  verifyInstallState: (await importOriginal<typeof import("~/lib/github-connection.server")>())
    .verifyInstallState,
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  importInstallationConnections: mocks.importInstallationConnections,
  recordInstallationAuthorization: mocks.recordInstallationAuthorization,
  setBackfillState: mocks.setBackfillState,
  subscribeInstallation: mocks.subscribeInstallation,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

vi.mock("../api.github.backfill-run", () => ({
  kickBackfillRun: mocks.kickBackfillRun,
}));

import { signInstallState } from "~/lib/github-connection.server";
import { loader } from "../api.github.setup";

function signedState(userId = "user_1", issuedAt = Date.now()): string {
  return signInstallState({ docoId: "doco_1", userId, issuedAt }) ?? "";
}

function setupRequest(
  params = `installation_id=42&code=gh-code&state=${encodeURIComponent(signedState())}`,
): Request {
  return new Request(`https://doco.test/api/github/setup?${params}`);
}

describe("api.github.setup loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOCO_GITHUB_APP_CLIENT_SECRET = "app-secret";
    mocks.exchangeInstallationCode.mockResolvedValue("ghu_user");
    mocks.listUserInstallationIds.mockResolvedValue(new Set([42]));
    mocks.getDocoByIdOrHandle.mockResolvedValue({
      id: "doco_1",
      handle: "prs",
      owner_id: "workspace_1",
    });
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_1" });
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "prs",
      workspaceHandle: "doco",
      connections: [],
      installations: [],
      backfill: null,
    });
    mocks.getInstallationAccount.mockResolvedValue({ account: "acme" });
    mocks.importInstallationConnections.mockResolvedValue({ repos: [] });
    mocks.kickBackfillRun.mockResolvedValue(undefined);
    mocks.recordInstallationAuthorization.mockResolvedValue([]);
    mocks.setBackfillState.mockResolvedValue(undefined);
    mocks.subscribeInstallation.mockResolvedValue([]);
  });

  it("records the GitHub installation and returns to the repository chooser", async () => {
    const response = await loader({ request: setupRequest() });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/prs/integrations/github?github=connected");
    expect(mocks.getInstallationAccount).toHaveBeenCalledWith(42);
    expect(mocks.recordInstallationAuthorization).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({
        installation_id: 42,
        account: "acme",
        connected_at: expect.any(String),
      }),
    );
    expect(mocks.subscribeInstallation).not.toHaveBeenCalled();
    expect(mocks.importInstallationConnections).not.toHaveBeenCalled();
    expect(mocks.exchangeInstallationCode).toHaveBeenCalledWith("gh-code");
    expect(mocks.listUserInstallationIds).toHaveBeenCalledWith("ghu_user");
  });

  it("refuses an installation the installing GitHub user cannot access", async () => {
    mocks.listUserInstallationIds.mockResolvedValue(new Set([7]));

    const response = await loader({ request: setupRequest() });

    expect(response.headers.get("Location")).toBe(
      "/prs/integrations/github?github=installation_not_yours",
    );
    expect(mocks.recordInstallationAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a callback without GitHub's user authorization code", async () => {
    const response = await loader({
      request: setupRequest(`installation_id=42&state=${encodeURIComponent(signedState())}`),
    });

    expect(response.headers.get("Location")).toBe(
      "/prs/integrations/github?github=authorization_required",
    );
    expect(mocks.recordInstallationAuthorization).not.toHaveBeenCalled();
  });

  it("refuses an unsigned state (a bare Doco id)", async () => {
    const response = await loader({
      request: setupRequest("installation_id=42&code=gh-code&state=doco_1"),
    });

    expect(response.headers.get("Location")).toBe("/workspaces?github=setup_error");
    expect(mocks.recordInstallationAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a state signed for a different Doco user", async () => {
    const response = await loader({
      request: setupRequest(
        `installation_id=42&code=gh-code&state=${encodeURIComponent(signedState("user_2"))}`,
      ),
    });

    expect(response.headers.get("Location")).toBe("/prs/integrations/github?github=forbidden");
    expect(mocks.recordInstallationAuthorization).not.toHaveBeenCalled();
  });

  it("does not import repositories until the user selects them", async () => {
    mocks.importInstallationConnections.mockResolvedValue({ repos: ["acme/app"] });

    const response = await loader({ request: setupRequest() });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/prs/integrations/github?github=connected");
    expect(mocks.recordInstallationAuthorization).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ installation_id: 42, account: "acme" }),
    );
    expect(mocks.importInstallationConnections).not.toHaveBeenCalled();
    expect(mocks.setBackfillState).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });
});
