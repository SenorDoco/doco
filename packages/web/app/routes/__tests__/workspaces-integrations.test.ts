import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  resolveWorkspaceByHandle: vi.fn(),
  getWorkspaceRole: vi.fn(),
  loadWorkspaceIntegrationsRollup: vi.fn(),
  listSlackInstallations: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/slack.server", () => ({
  listSlackInstallations: mocks.listSlackInstallations,
}));

vi.mock("~/lib/workspace-helpers.server", () => ({
  resolveWorkspaceByHandle: mocks.resolveWorkspaceByHandle,
}));

vi.mock("@doco/db", () => ({
  getWorkspaceRole: mocks.getWorkspaceRole,
}));

vi.mock("~/lib/integrations-summary.server", () => ({
  loadWorkspaceIntegrationsRollup: mocks.loadWorkspaceIntegrationsRollup,
}));

import { loader } from "../workspaces.$workspaceHandle.integrations";

describe("/workspaces/:workspaceHandle/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSlackInstallations.mockResolvedValue([]);
    mocks.loadWorkspaceIntegrationsRollup.mockResolvedValue({
      workspaceId: "workspace_acme",
      workspaceHandle: "acme",
      docos: [],
    });
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/workspaces/acme/integrations"),
      params: { workspaceHandle: "acme" },
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/sign-in?next=%2Fworkspaces%2Facme%2Fintegrations",
    );
  });

  it("returns 404 for a missing workspace", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveWorkspaceByHandle.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/workspaces/missing/integrations"),
      params: { workspaceHandle: "missing" },
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(404);
  });

  it("returns 403 when the user has no role in the workspace", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveWorkspaceByHandle.mockResolvedValue({
      id: "workspace_acme",
      handle: "acme",
      constitution: "",
    });
    mocks.getWorkspaceRole.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/workspaces/acme/integrations"),
      params: { workspaceHandle: "acme" },
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(403);
  });

  it("loads the workspace rollup for members", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveWorkspaceByHandle.mockResolvedValue({
      id: "workspace_acme",
      handle: "acme",
      constitution: "",
    });
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    const rollup = {
      workspaceId: "workspace_acme",
      workspaceHandle: "acme",
      docos: [
        {
          docoId: "doco_one",
          handle: "acme-one",
          workspaceHandle: "acme",
          githubRepoCount: 1,
        },
      ],
    };
    mocks.loadWorkspaceIntegrationsRollup.mockResolvedValue(rollup);

    const data = await loader({
      request: new Request("https://doco.test/workspaces/acme/integrations"),
      params: { workspaceHandle: "acme" },
    });

    expect(data.me).toEqual({ id: "user_alice", username: "alice" });
    expect(data.workspace).toEqual({
      id: "workspace_acme",
      handle: "acme",
      constitution: "",
    });
    expect(data.rollup).toEqual(rollup);
  });

  it("loads only the Slack teams bound to this workspace, and lets an owner manage them", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveWorkspaceByHandle.mockResolvedValue({
      id: "workspace_acme",
      handle: "acme",
      constitution: "",
    });
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.listSlackInstallations.mockResolvedValue([
      {
        workspaceId: "T1",
        workspaceName: "Torre.ai",
        botUserId: "U1",
        installedAt: "2026-06-03T00:00:00.000Z",
        docoWorkspaceId: "workspace_acme",
      },
      {
        workspaceId: "T2",
        workspaceName: "Other Co",
        botUserId: "U2",
        installedAt: "2026-06-03T00:00:00.000Z",
        docoWorkspaceId: "workspace_other",
      },
    ]);

    const data = await loader({
      request: new Request("https://doco.test/workspaces/acme/integrations"),
      params: { workspaceHandle: "acme" },
    });

    // Only the team bound to THIS workspace, trimmed to what the card needs.
    expect(data.slack).toEqual([
      { teamId: "T1", teamName: "Torre.ai", installedAt: "2026-06-03T00:00:00.000Z" },
    ]);
    expect(data.canManageSlack).toBe(true);
  });

  it("shows bound Slack to a non-owner member but withholds the Remove control", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveWorkspaceByHandle.mockResolvedValue({
      id: "workspace_acme",
      handle: "acme",
      constitution: "",
    });
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    mocks.listSlackInstallations.mockResolvedValue([
      {
        workspaceId: "T1",
        workspaceName: "Torre.ai",
        botUserId: "U1",
        installedAt: "2026-06-03T00:00:00.000Z",
        docoWorkspaceId: "workspace_acme",
      },
    ]);

    const data = await loader({
      request: new Request("https://doco.test/workspaces/acme/integrations"),
      params: { workspaceHandle: "acme" },
    });

    expect(data.slack).toHaveLength(1);
    expect(data.canManageSlack).toBe(false);
  });
});
