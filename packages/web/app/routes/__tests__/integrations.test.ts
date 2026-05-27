import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  loadScopeOptions: vi.fn(),
  getSlackConfig: vi.fn(),
  listSlackInstallations: vi.fn(),
  saveSlackChannelConnection: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/api-keys.server", () => ({
  loadScopeOptions: mocks.loadScopeOptions,
}));

vi.mock("~/lib/slack.server", () => ({
  getSlackConfig: mocks.getSlackConfig,
  listSlackInstallations: mocks.listSlackInstallations,
  saveSlackChannelConnection: mocks.saveSlackChannelConnection,
}));

import { action, loader } from "../integrations";

describe("/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackConfig.mockReturnValue({ configured: false });
    mocks.listSlackInstallations.mockResolvedValue([]);
    mocks.saveSlackChannelConnection.mockResolvedValue(undefined);
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/integrations"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in?next=%2Fintegrations");
  });

  it("loads the signed-in user's accessible integration targets", async () => {
    mocks.getSlackConfig.mockReturnValue({ configured: true });
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "author",
      },
    ]);

    await expect(
      loader({ request: new Request("https://doco.test/integrations") }),
    ).resolves.toEqual({
      me: {
        id: "collaborator_alice",
        username: "alice",
      },
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: "slack",
          installHref: "/integrations/slack/install",
        }),
        expect.objectContaining({
          id: "google-chat",
          installHref: null,
        }),
      ]),
      scopeOptions: [
        {
          level: "doco",
          id: "doco_bpms",
          label: "torre/bpms",
          myRole: "author",
        },
      ],
      slackInstallations: [],
      slackChannelContext: null,
      initialProviderId: "slack",
      notice: null,
    });
    expect(mocks.loadScopeOptions).toHaveBeenCalledWith("collaborator_alice");
  });

  it("does not expose deployment environment variable names to the browser", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([]);

    const data = await loader({ request: new Request("https://doco.test/integrations") });

    expect(data.providers[0]).toMatchObject({
      id: "slack",
      installHref: null,
      setupSummary: "Add the Slack app credentials to the deployment.",
    });
    expect(data.providers[0]).not.toHaveProperty("installEnv");
  });

  it("reads Slack channel context from the /doco connect link", async () => {
    mocks.getSlackConfig.mockReturnValue({ configured: true });
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([]);

    const data = await loader({
      request: new Request(
        "https://doco.test/integrations?provider=slack&team_id=T123&team_name=acme&channel_id=C123&channel_name=product",
      ),
    });

    expect(data.initialProviderId).toBe("slack");
    expect(data.slackChannelContext).toEqual({
      teamId: "T123",
      teamName: "acme",
      channelId: "C123",
      channelName: "product",
    });
  });

  it("saves a Slack channel default only up to the user's Doco role", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "author",
      },
    ]);
    const body = new URLSearchParams({
      intent: "save_slack_channel_default",
      team_id: "T123",
      channel_id: "C123",
      channel_name: "product",
      target_level: "doco",
      target_id: "doco_bpms",
      role: "author",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations", {
        method: "POST",
        body,
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?provider=slack&connected=product");
    expect(mocks.saveSlackChannelConnection).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      channelName: "product",
      targetLevel: "doco",
      targetId: "doco_bpms",
      role: "author",
      createdByCollaboratorId: "collaborator_alice",
    });
  });

  it("rejects a Slack channel default above the user's role", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "author",
      },
    ]);
    const body = new URLSearchParams({
      intent: "save_slack_channel_default",
      team_id: "T123",
      channel_id: "C123",
      channel_name: "product",
      target_level: "doco",
      target_id: "doco_bpms",
      role: "approver",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations", {
        method: "POST",
        body,
      }),
    })) as Response;

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Cannot set channel default 'approver' because your access is 'author'.",
    });
    expect(mocks.saveSlackChannelConnection).not.toHaveBeenCalled();
  });
});
