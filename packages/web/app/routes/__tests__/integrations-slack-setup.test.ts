import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  loadScopeOptions: vi.fn(),
  listSlackInstallations: vi.fn(),
  replaceSlackChannelConnections: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/api-keys.server", () => ({
  loadScopeOptions: mocks.loadScopeOptions,
}));

vi.mock("~/lib/slack.server", () => ({
  listSlackInstallations: mocks.listSlackInstallations,
  replaceSlackChannelConnections: mocks.replaceSlackChannelConnections,
}));

import { action, loader } from "../integrations.slack.setup";

describe("/integrations/slack/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
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
        myRole: "writer",
      },
      {
        level: "doco",
        id: "doco_sales",
        label: "torre/sales",
        myRole: "writer",
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
    mocks.replaceSlackChannelConnections.mockResolvedValue(undefined);
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

  it("loads org-first permission groups for the selected Slack installation", async () => {
    const data = await loader({
      request: new Request("https://doco.test/integrations/slack/setup?team_id=T123"),
    });

    expect(data.installation.workspaceName).toBe("Doco");
    expect(data.orgGroups).toEqual([
      {
        key: "torre",
        handle: "torre",
        orgOption: {
          level: "org",
          id: "org_torre",
          label: "torre",
          myRole: "owner",
        },
        docos: [
          {
            id: "doco_bpms",
            label: "torre/bpms",
            myRole: "writer",
          },
          {
            id: "doco_sales",
            label: "torre/sales",
            myRole: "writer",
          },
        ],
      },
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

  it("saves workspace-wide organization defaults up to the user's org role", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      org_key: "torre",
      "org_mode:torre": "all",
      "org_role:torre": "writer",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_connected=Doco");
    expect(mocks.replaceSlackChannelConnections).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "*",
      channelName: "workspace",
      grants: [
        {
          targetLevel: "org",
          targetId: "org_torre",
          role: "writer",
        },
      ],
      createdByUserId: "user_alice",
    });
  });

  it("defaults a selected organization to reader if the role control did not submit", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      org_key: "torre",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(mocks.replaceSlackChannelConnections).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "*",
        grants: [
          {
            targetLevel: "org",
            targetId: "org_torre",
            role: "reader",
          },
        ],
      }),
    );
  });

  it("saves specific Doco defaults while leaving no-access Docos out", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      org_key: "torre",
      "org_mode:torre": "specific",
      "doco_role:doco_bpms": "reader",
      "doco_role:doco_sales": "none",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(mocks.replaceSlackChannelConnections).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "*",
        grants: [
          {
            targetLevel: "doco",
            targetId: "doco_bpms",
            role: "reader",
          },
        ],
      }),
    );
  });

  it("rejects workspace defaults above the user's Doco role", async () => {
    // This user only holds reader on doco_bpms, so a writer default is
    // above their access.
    mocks.loadScopeOptions.mockResolvedValueOnce([
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "reader",
      },
    ]);
    const body = new URLSearchParams({
      workspace_id: "T123",
      org_key: "torre",
      "org_mode:torre": "specific",
      "doco_role:doco_bpms": "writer",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    })) as Response;

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Cannot set default permissions 'writer' because your access is 'reader'.",
    });
    expect(mocks.replaceSlackChannelConnections).not.toHaveBeenCalled();
  });

  it("does not allow owner as a shared workspace default role", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      org_key: "torre",
      "org_mode:torre": "all",
      "org_role:torre": "owner",
    });

    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", {
        method: "POST",
        body,
      }),
    })) as Response;

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "pick_at_least_one_default_permission" });
    expect(mocks.replaceSlackChannelConnections).not.toHaveBeenCalled();
  });
});
