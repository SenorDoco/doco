import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getSlackConfig: vi.fn(),
  listSlackInstallations: vi.fn(),
  loadAccountIntegrationsRollup: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/slack.server", () => ({
  getSlackConfig: mocks.getSlackConfig,
  listSlackInstallations: mocks.listSlackInstallations,
}));

vi.mock("~/lib/integrations-summary.server", () => ({
  loadAccountIntegrationsRollup: mocks.loadAccountIntegrationsRollup,
}));

import { loader } from "../integrations";

describe("/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackConfig.mockReturnValue({ configured: false });
    mocks.listSlackInstallations.mockResolvedValue([]);
    mocks.loadAccountIntegrationsRollup.mockResolvedValue({
      slack: [],
      workspaces: [],
      docos: [],
    });
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/integrations"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in?next=%2Fintegrations");
  });

  it("loads slack workspaces and cross-scope rollup for signed-in users", async () => {
    mocks.getSlackConfig.mockReturnValue({ configured: true });
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
    const slackInstallations = [
      {
        workspaceId: "T123",
        workspaceName: "Doco",
        botUserId: "U123",
        installedAt: "2026-05-26T20:00:00.000Z",
      },
    ];
    mocks.listSlackInstallations.mockResolvedValue(slackInstallations);
    mocks.loadAccountIntegrationsRollup.mockResolvedValue({
      slack: [],
      workspaces: [{ workspaceId: "workspace_acme", handle: "acme", installCount: 0 }],
      docos: [
        {
          docoId: "doco_one",
          handle: "acme-doco",
          workspaceHandle: "acme",
          githubRepoCount: 2,
        },
      ],
    });

    const data = await loader({ request: new Request("https://doco.test/integrations") });

    expect(data.me).toEqual({ id: "user_alice", username: "alice" });
    expect(data.slackInstallHref).toBe("/integrations/slack/install");
    expect(data.slackInstallations).toEqual(slackInstallations);
    expect(data.rollup.slack).toEqual(slackInstallations);
    expect(data.rollup.workspaces).toHaveLength(1);
    expect(data.rollup.docos).toHaveLength(1);
    expect(mocks.loadAccountIntegrationsRollup).toHaveBeenCalledWith({ userId: "user_alice" });
  });

  it("does not expose deployment environment variable names to the browser", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });

    const data = await loader({ request: new Request("https://doco.test/integrations") });

    expect(data.slackInstallHref).toBeNull();
    expect(data.slackConfirmation).toBeNull();
    expect(JSON.stringify(data)).not.toContain("SLACK_CLIENT_SECRET");
    expect(JSON.stringify(data)).not.toContain("DOCO_SLACK_INSTALL_URL");
  });

  it("shows a workspace-default confirmation", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });

    const data = await loader({
      request: new Request("https://doco.test/integrations?slack_connected=Doco"),
    });

    expect(data.notice).toBeNull();
    expect(data.slackConfirmation).toEqual({ workspaceName: "Doco" });
  });
});
