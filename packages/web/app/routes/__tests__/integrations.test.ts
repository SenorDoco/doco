import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getSlackConfig: vi.fn(),
  listSlackInstallations: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/slack.server", () => ({
  getSlackConfig: mocks.getSlackConfig,
  listSlackInstallations: mocks.listSlackInstallations,
}));

import { loader } from "../integrations";

describe("/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackConfig.mockReturnValue({ configured: false });
    mocks.listSlackInstallations.mockResolvedValue([]);
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/integrations"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in?next=%2Fintegrations");
  });

  it("loads a minimal Slack entry point for signed-in users", async () => {
    mocks.getSlackConfig.mockReturnValue({ configured: true });
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
    mocks.listSlackInstallations.mockResolvedValue([
      {
        workspaceId: "T123",
        workspaceName: "Doco",
        botUserId: "U123",
        installedAt: "2026-05-26T20:00:00.000Z",
      },
    ]);

    await expect(
      loader({ request: new Request("https://doco.test/integrations") }),
    ).resolves.toEqual({
      me: {
        id: "user_alice",
        username: "alice",
      },
      notice: null,
      slackConfirmation: null,
      slackInstallHref: "/integrations/slack/install",
      slackInstallations: [
        {
          workspaceId: "T123",
          workspaceName: "Doco",
          botUserId: "U123",
          installedAt: "2026-05-26T20:00:00.000Z",
        },
      ],
    });
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
