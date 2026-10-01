import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoByIdOrHandle: vi.fn(),
  getDocoLevelRole: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  connectPicked: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  getInstallationAccount: vi.fn(),
  listGitHubInstallationChoicesForDocos: vi.fn(),
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
  // The real picker: only what the installation offers is connected.
  pickConnections: (await importOriginal<typeof import("~/lib/github-connection.server")>())
    .pickConnections,
  connectPicked: mocks.connectPicked,
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  importInstallationConnections: mocks.importInstallationConnections,
  listGitHubInstallationChoicesForDocos: mocks.listGitHubInstallationChoicesForDocos,
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

function signedState(
  userId = "user_1",
  docoIds = ["doco_1"],
  next = "/prs/integrations/github",
  connectAll = false,
): string {
  return (
    signInstallState({
      userId,
      docoIds,
      next,
      ...(connectAll ? { connectAll } : {}),
      issuedAt: Date.now(),
    }) ?? ""
  );
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
    mocks.getDocoByIdOrHandle.mockImplementation(async (id: string) => ({
      id,
      handle: id === "doco_1" ? "prs" : "bugs",
      owner_id: "workspace_1",
    }));
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

  it("makes the installation selectable on every Doco the setup brings things into", async () => {
    const state = signedState(
      "user_1",
      ["doco_1", "doco_2"],
      "/integrations/github?workspace=acme",
    );
    const response = await loader({
      request: setupRequest(`installation_id=42&code=gh-code&state=${encodeURIComponent(state)}`),
    });

    expect(response.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&github=connected",
    );
    expect(mocks.recordInstallationAuthorization).toHaveBeenCalledTimes(2);
    for (const docoId of ["doco_1", "doco_2"]) {
      expect(mocks.recordInstallationAuthorization).toHaveBeenCalledWith(
        docoId,
        expect.objectContaining({ installation_id: 42, account: "acme" }),
      );
    }
  });

  it("records nothing when the user can't write to one of the Docos", async () => {
    mocks.getDocoLevelRole.mockImplementation(async (meta: { docoId: string }) =>
      meta.docoId === "doco_2" ? "reader" : "writer",
    );
    const state = signedState("user_1", ["doco_1", "doco_2"], "/integrations/github");
    const response = await loader({
      request: setupRequest(`installation_id=42&code=gh-code&state=${encodeURIComponent(state)}`),
    });

    expect(response.headers.get("Location")).toBe("/integrations/github?github=forbidden");
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

  // A workspace's one-click Connect GitHub: nothing left to pick once GitHub
  // sends the person back, so every repository the installation grants, and
  // the organization as a whole, start importing into each Doco.
  it("connects everything the installation grants when the setup asked for it", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      { installation_id: 42, account: "acme", repositories: ["acme/app", "acme/api"] },
      { installation_id: 7, account: "other", repositories: ["other/site"] },
    ]);
    mocks.connectPicked.mockResolvedValue(true);
    const state = signedState("user_1", ["doco_1", "doco_2"], "/workspaces/acme", true);
    const response = await loader({
      request: setupRequest(`installation_id=42&code=gh-code&state=${encodeURIComponent(state)}`),
    });

    expect(response.headers.get("Location")).toBe("/workspaces/acme?github=importing");
    for (const docoId of ["doco_1", "doco_2"]) {
      expect(mocks.connectPicked).toHaveBeenCalledWith(docoId, {
        connections: [
          { repo: "acme/app", installation_id: 42 },
          { repo: "acme/api", installation_id: 42 },
        ],
        installations: [expect.objectContaining({ installation_id: 42, account: "acme" })],
      });
      expect(mocks.kickBackfillRun).toHaveBeenCalledWith("https://doco.test", docoId);
    }
  });
});
