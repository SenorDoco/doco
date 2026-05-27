import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  loadScopeOptions: vi.fn(),
  listSlackChannels: vi.fn(),
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
  listSlackChannels: mocks.listSlackChannels,
  listSlackInstallations: mocks.listSlackInstallations,
  saveSlackChannelConnection: mocks.saveSlackChannelConnection,
}));

import { action, loader } from "../integrations.slack.setup";

describe("/integrations/slack/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([
      {
        level: "org",
        id: "org_torre",
        label: "torre",
        myRole: "owner",
      },
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "author",
      },
    ]);
    mocks.listSlackInstallations.mockResolvedValue([
      {
        workspaceId: "T123",
        workspaceName: "Doco",
        botUserId: "U123",
        installedAt: "2026-05-26T20:00:00.000Z",
      },
    ]);
    mocks.listSlackChannels.mockResolvedValue([
      {
        id: "C111",
        name: "all-doco",
        isPrivate: false,
      },
    ]);
    mocks.saveSlackChannelConnection.mockResolvedValue(undefined);
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/integrations/slack/setup?team_id=T123"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/sign-in?next=%2Fintegrations%2Fslack%2Fsetup%3Fteam_id%3DT123",
    );
  });

  it("loads channel choices and explicit org-wide Doco targets", async () => {
    const data = await loader({
      request: new Request(
        "https://doco.test/integrations/slack/setup?team_id=T123&channel_id=C222&channel_name=product",
      ),
    });

    expect(data.installation.workspaceName).toBe("Doco");
    expect(data.initialChannelId).toBe("C222");
    expect(data.channels).toEqual([
      {
        id: "C222",
        name: "product",
        isPrivate: false,
      },
      {
        id: "C111",
        name: "all-doco",
        isPrivate: false,
      },
    ]);
    expect(data.targetOptions).toEqual([
      expect.objectContaining({
        value: "org:org_torre",
        displayLabel: "torre/* - all Docos in torre",
        grantLabel: "torre/*",
      }),
      expect.objectContaining({
        value: "doco:doco_bpms",
        displayLabel: "torre/bpms",
        grantLabel: "torre/bpms",
      }),
    ]);
  });

  it("redirects back to integrations if Slack has not been installed", async () => {
    mocks.listSlackInstallations.mockResolvedValue([]);

    const response = (await loader({
      request: new Request("https://doco.test/integrations/slack/setup"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_not_installed=1");
  });

  it("saves an org-wide Slack channel default up to the user's role", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      channel_id: "C111",
      channel_name: "all-doco",
      target: "org:org_torre",
      role: "approver",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_connected=all-doco");
    expect(mocks.saveSlackChannelConnection).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C111",
      channelName: "all-doco",
      targetLevel: "org",
      targetId: "org_torre",
      role: "approver",
      createdByCollaboratorId: "collaborator_alice",
    });
  });

  it("rejects channel defaults above the user's Doco role", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      channel_id: "C111",
      channel_name: "all-doco",
      target: "doco:doco_bpms",
      role: "approver",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
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

  it("does not allow owner as a shared channel default role", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      channel_id: "C111",
      channel_name: "all-doco",
      target: "org:org_torre",
      role: "owner",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    })) as Response;

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_channel_default_role" });
    expect(mocks.saveSlackChannelConnection).not.toHaveBeenCalled();
  });
});
