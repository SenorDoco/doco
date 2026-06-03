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

// The Slack team is bound to workspace_torre at install; setup only configures
// default access WITHIN it — it never re-picks a workspace.
function installation(docoWorkspaceId: string | null) {
  return {
    workspaceId: "T123",
    workspaceName: "Doco",
    botUserId: "U123",
    docoWorkspaceId,
    installedAt: "2026-05-26T20:00:00.000Z",
  };
}

describe("/integrations/slack/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.loadScopeOptions.mockResolvedValue([
      { level: "workspace", id: "workspace_torre", label: "torre", myRole: "owner" },
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "writer",
        workspaceId: "workspace_torre",
      },
      {
        level: "doco",
        id: "doco_sales",
        label: "torre/sales",
        myRole: "writer",
        workspaceId: "workspace_torre",
      },
    ]);
    mocks.listSlackInstallations.mockResolvedValue([installation("workspace_torre")]);
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

  it("redirects to install when the team has no bound workspace", async () => {
    mocks.listSlackInstallations.mockResolvedValue([installation(null)]);
    const response = (await loader({
      request: new Request("https://doco.test/integrations/slack/setup?team_id=T123"),
    }).catch((error: Response) => error)) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations/slack/install");
  });

  it("scopes the permission groups to the team's bound workspace (excludes others)", async () => {
    // The user owns another workspace too, but setup must show only the bound one.
    mocks.loadScopeOptions.mockResolvedValue([
      { level: "workspace", id: "workspace_torre", label: "torre", myRole: "owner" },
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "writer",
        workspaceId: "workspace_torre",
      },
      { level: "workspace", id: "workspace_meta", label: "meta", myRole: "owner" },
      {
        level: "doco",
        id: "doco_other",
        label: "meta/x",
        myRole: "owner",
        workspaceId: "workspace_meta",
      },
    ]);
    const data = await loader({
      request: new Request("https://doco.test/integrations/slack/setup?team_id=T123"),
    });
    expect(data.installation.workspaceName).toBe("Doco");
    expect(data.workspaceGroups.map((g) => g.handle)).toEqual(["torre"]);
    expect(data.workspaceGroups[0].docos.map((d) => d.id)).toEqual(["doco_bpms"]);
  });

  it("redirects back to integrations if Slack has not been installed", async () => {
    mocks.listSlackInstallations.mockResolvedValue([]);
    const response = (await loader({
      request: new Request("https://doco.test/integrations/slack/setup"),
    }).catch((error: Response) => error)) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_not_installed=1");
  });

  it("saves a workspace-wide default within the bound workspace", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      workspace_key: "torre",
      "workspace_mode:torre": "all",
      "workspace_role:torre": "writer",
    });
    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", { method: "POST", body }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_connected=Doco");
    expect(mocks.replaceSlackChannelConnections).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "*",
      channelName: "workspace",
      grants: [{ targetLevel: "workspace", targetId: "workspace_torre", role: "writer" }],
      createdByUserId: "user_alice",
    });
  });

  it("ignores defaults aimed at a workspace other than the bound one", async () => {
    // The user owns meta too, but the team is bound to torre — a meta default is
    // scoped out, so nothing it asks for is saved.
    mocks.loadScopeOptions.mockResolvedValue([
      { level: "workspace", id: "workspace_torre", label: "torre", myRole: "owner" },
      { level: "workspace", id: "workspace_meta", label: "meta", myRole: "owner" },
    ]);
    const body = new URLSearchParams({
      workspace_id: "T123",
      workspace_key: "meta",
      "workspace_mode:meta": "all",
      "workspace_role:meta": "reader",
    });
    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", { method: "POST", body }),
    })) as Response;

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "pick_at_least_one_default_permission" });
    expect(mocks.replaceSlackChannelConnections).not.toHaveBeenCalled();
  });

  it("saves specific Doco defaults while leaving no-access Docos out", async () => {
    const body = new URLSearchParams({
      workspace_id: "T123",
      workspace_key: "torre",
      "workspace_mode:torre": "specific",
      "doco_role:doco_bpms": "reader",
      "doco_role:doco_sales": "none",
    });
    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", { method: "POST", body }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(mocks.replaceSlackChannelConnections).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "*",
        grants: [{ targetLevel: "doco", targetId: "doco_bpms", role: "reader" }],
      }),
    );
  });

  it("rejects a default above the user's Doco role", async () => {
    mocks.loadScopeOptions.mockResolvedValue([
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "reader",
        workspaceId: "workspace_torre",
      },
    ]);
    const body = new URLSearchParams({
      workspace_id: "T123",
      workspace_key: "torre",
      "workspace_mode:torre": "specific",
      "doco_role:doco_bpms": "writer",
    });
    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", { method: "POST", body }),
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
      workspace_key: "torre",
      "workspace_mode:torre": "all",
      "workspace_role:torre": "owner",
    });
    const response = (await action({
      request: new Request("https://doco.test/integrations/slack/setup", { method: "POST", body }),
    })) as Response;

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "pick_at_least_one_default_permission" });
    expect(mocks.replaceSlackChannelConnections).not.toHaveBeenCalled();
  });
});
