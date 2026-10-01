import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  listSlackInstallations: vi.fn(),
  removeSlackInstallation: vi.fn(),
  loadAccountIntegrationsRollup: vi.fn(),
  loadDocoPicker: vi.fn(),
  getWorkspaceRole: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/slack.server", () => ({
  listSlackInstallations: mocks.listSlackInstallations,
  removeSlackInstallation: mocks.removeSlackInstallation,
}));

vi.mock("~/lib/integrations-summary.server", () => ({
  loadAccountIntegrationsRollup: mocks.loadAccountIntegrationsRollup,
  loadDocoPicker: mocks.loadDocoPicker,
}));

vi.mock("@doco/db", () => ({
  getWorkspaceRole: mocks.getWorkspaceRole,
}));

import { action, loader } from "../integrations";

// The Slack team T123 is bound to workspace_torre at install. Removal requires
// the actor to OWN that workspace (the inverse of install, which is owner-only).
function slackInstall(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "T123",
    workspaceName: "Doco",
    botUserId: "U123",
    docoWorkspaceId: "workspace_torre",
    installedAt: "2026-05-26T20:00:00.000Z",
    ...over,
  };
}

function removeRequest(body: Record<string, string>): Request {
  return new Request("https://doco.test/integrations", {
    method: "POST",
    body: new URLSearchParams(body),
  });
}

describe("/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSlackInstallations.mockResolvedValue([]);
    mocks.removeSlackInstallation.mockResolvedValue(true);
    mocks.getWorkspaceRole.mockResolvedValue(null);
    mocks.loadAccountIntegrationsRollup.mockResolvedValue({
      slack: [],
      workspaces: [],
      docos: [],
    });
    mocks.loadDocoPicker.mockResolvedValue(null);
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/integrations"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in?next=%2Fintegrations");
  });

  it("returns the cross-scope rollup (Slack carried on the rollup) for signed-in users", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    const slackInstallations = [
      {
        workspaceId: "T123",
        workspaceName: "Doco",
        botUserId: "U123",
        installedAt: "2026-05-26T20:00:00.000Z",
        docoWorkspaceId: "workspace_acme",
      },
    ];
    mocks.loadAccountIntegrationsRollup.mockResolvedValue({
      slack: slackInstallations,
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

  it("surfaces a removed notice on the loader", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });

    const data = await loader({
      request: new Request("https://doco.test/integrations?slack_removed=Doco"),
    });

    expect(data.notice).toBe("Slack workspace removed: Doco.");
  });

  it("loads the doco picker for the integration a Set up... click names", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    const picker = { integrationId: "notion", workspaces: [] };
    mocks.loadDocoPicker.mockResolvedValue(picker);

    const data = await loader({
      request: new Request("https://doco.test/integrations?integration=notion"),
    });

    expect(mocks.loadDocoPicker).toHaveBeenCalledWith({
      integrationId: "notion",
      userId: "user_alice",
    });
    expect(data.docoPicker).toBe(picker);
  });
});

describe("/integrations remove-Slack action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.listSlackInstallations.mockResolvedValue([slackInstall()]);
    mocks.removeSlackInstallation.mockResolvedValue(true);
    mocks.getWorkspaceRole.mockResolvedValue("owner");
  });

  it("rejects anonymous callers", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    const response = (await action({
      request: removeRequest({ intent: "remove_slack", workspace_id: "T123" }),
    })) as Response;
    expect(response.status).toBe(401);
    expect(mocks.removeSlackInstallation).not.toHaveBeenCalled();
  });

  it("rejects a non-owner of the bound workspace", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    const response = (await action({
      request: removeRequest({ intent: "remove_slack", workspace_id: "T123" }),
    })) as Response;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "owner_required" });
    expect(mocks.removeSlackInstallation).not.toHaveBeenCalled();
  });

  it("removes the team for an owner of the bound workspace", async () => {
    const response = (await action({
      request: removeRequest({ intent: "remove_slack", workspace_id: "T123" }),
    }).catch((error: Response) => error)) as Response;
    expect(mocks.getWorkspaceRole).toHaveBeenCalledWith("workspace_torre", "user_alice");
    expect(mocks.removeSlackInstallation).toHaveBeenCalledWith("T123");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_removed=Doco");
  });

  it("lets any signed-in user clear an unbound team without an ownership check", async () => {
    mocks.listSlackInstallations.mockResolvedValue([slackInstall({ docoWorkspaceId: null })]);
    const response = (await action({
      request: removeRequest({ intent: "remove_slack", workspace_id: "T123" }),
    }).catch((error: Response) => error)) as Response;
    expect(mocks.getWorkspaceRole).not.toHaveBeenCalled();
    expect(mocks.removeSlackInstallation).toHaveBeenCalledWith("T123");
    expect(response.status).toBe(302);
  });

  it("is idempotent when the team is already gone", async () => {
    mocks.listSlackInstallations.mockResolvedValue([]);
    const response = (await action({
      request: removeRequest({ intent: "remove_slack", workspace_id: "T999" }),
    }).catch((error: Response) => error)) as Response;
    expect(mocks.removeSlackInstallation).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations?slack_removed=1");
  });

  it("requires a workspace id", async () => {
    const response = (await action({
      request: removeRequest({ intent: "remove_slack" }),
    })) as Response;
    expect(response.status).toBe(400);
    expect(mocks.removeSlackInstallation).not.toHaveBeenCalled();
  });
});
