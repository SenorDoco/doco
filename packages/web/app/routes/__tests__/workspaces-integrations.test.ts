import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  resolveWorkspaceByHandle: vi.fn(),
  getWorkspaceRole: vi.fn(),
  loadWorkspaceIntegrationsRollup: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
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
});
