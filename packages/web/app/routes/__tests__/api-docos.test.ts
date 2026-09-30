import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDocoInWorkspace: vi.fn(),
  getOauthTokenForRequest: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listVisibleDocoIdsForRequest: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getWorkspaceRole: mocks.getWorkspaceRole,
  roleAtLeast: (role: string | null, threshold: string) => {
    const rank: Record<string, number> = { reader: 0, author: 1, approver: 2, owner: 3 };
    return role !== null && rank[role] >= rank[threshold];
  },
  withClient: (fn: (client: { query: typeof mocks.query }) => unknown) =>
    fn({ query: mocks.query }),
}));

vi.mock("~/lib/doco-access.server", () => ({
  // Non-agent requests here; the Señor Doco guard is covered separately by
  // doco-access.server.test and docos-create.senor-doco-cap.test.
  isSenorDocoRequest: () => false,
  getOauthTokenForRequest: mocks.getOauthTokenForRequest,
  listVisibleDocoIdsForRequest: mocks.listVisibleDocoIdsForRequest,
}));

vi.mock("~/lib/redeem.server", () => ({
  createDocoInWorkspace: mocks.createDocoInWorkspace,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

import { action, loader } from "../api.v1.docos[.]json";

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://doco.test/api/v1/docos.json", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/v1/docos.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
    mocks.getOauthTokenForRequest.mockResolvedValue(null);
  });

  it("lists qualified workspace/doco handles", async () => {
    mocks.listVisibleDocoIdsForRequest.mockResolvedValue(["doco_bpms"]);
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "doco_bpms",
          handle: "bpms",
          workspace_id: "workspace_torre",
          workspace_handle: "torre",
        },
      ],
    });

    const response = await loader({ request: jsonRequest(undefined, "GET") } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      docos: [
        {
          id: "doco_bpms",
          handle: "bpms",
          workspace_id: "workspace_torre",
          workspace_handle: "torre",
          qualified_handle: "torre/bpms",
        },
      ],
    });
  });

  it("requires owner on the target workspace to create a doco", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");

    const response = await action({
      request: jsonRequest({ workspace_id: "workspace_torre", name: "bpms" }),
    } as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Only workspace owners can create docos -- you hold 'writer' on this workspace.",
    });
    expect(mocks.createDocoInWorkspace).not.toHaveBeenCalled();
  });

  it("creates a doco for workspace owners and returns the qualified handle", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.createDocoInWorkspace.mockResolvedValue({
      docoId: "doco_bpms",
      handle: "bpms",
      workspaceId: "workspace_torre",
      workspaceHandle: "torre",
      goal: "Process memory.",
    });

    const response = await action({
      request: jsonRequest({ workspace_id: "workspace_torre", name: "BPMS", privacy: "public" }),
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "doco_bpms",
      handle: "bpms",
      workspace_handle: "torre",
      workspace_id: "workspace_torre",
      qualified_handle: "torre/bpms",
      template_handle: "generic",
      visibility: "public",
      goal: "Process memory.",
    });
    expect(mocks.createDocoInWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_torre",
        requestedHandle: "bpms",
        createdByUserId: "user_alice",
      }),
    );
  });

  it("accepts the common template alias and returns the applied template handle", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.createDocoInWorkspace.mockResolvedValue({
      docoId: "doco_flow",
      handle: "flow",
      workspaceId: "workspace_torre",
      workspaceHandle: "torre",
      goal: "Process memory.",
    });

    const response = await action({
      request: jsonRequest({
        workspace_id: "workspace_torre",
        name: "Flow",
        template: "process",
      }),
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "doco_flow",
      handle: "flow",
      workspace_handle: "torre",
      workspace_id: "workspace_torre",
      qualified_handle: "torre/flow",
      template_handle: "process",
      visibility: "private",
      goal: "Process memory.",
    });
    expect(mocks.createDocoInWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_torre",
        requestedHandle: "flow",
        createdByUserId: "user_alice",
        templateHandle: "process",
      }),
    );
  });
  // An agent creates Docos through its connection (the MCP's doco_create, or
  // this route with its bearer). The connection's grant caps it: it must cover
  // the whole workspace at owner, on top of the human's own owner role.
  describe("through an agent's connection", () => {
    const created = {
      docoId: "doco_bugs",
      handle: "bugs",
      workspaceId: "workspace_torre",
      workspaceHandle: "torre",
      goal: "",
    };
    const regularToken = (overrides: Record<string, unknown>) => ({
      grant_type: "regular",
      actor_role: null,
      granted_doco_ids: [],
      granted_doco_roles: {},
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      ...overrides,
    });

    beforeEach(() => {
      mocks.getWorkspaceRole.mockResolvedValue("owner");
      mocks.createDocoInWorkspace.mockResolvedValue(created);
    });

    it("creates the Doco when the connection reaches all workspaces as owner", async () => {
      mocks.getOauthTokenForRequest.mockResolvedValue({ grant_type: "actor", actor_role: null });
      const response = await action({
        request: jsonRequest({ workspace_id: "workspace_torre", name: "bugs" }),
      } as never);
      expect(response.status).toBe(201);
    });

    it("creates the Doco when the connection holds the workspace as owner", async () => {
      mocks.getOauthTokenForRequest.mockResolvedValue(
        regularToken({
          granted_workspace_ids: ["workspace_torre"],
          granted_workspace_roles: { workspace_torre: "owner" },
        }),
      );
      const response = await action({
        request: jsonRequest({ workspace_id: "workspace_torre", name: "bugs" }),
      } as never);
      expect(response.status).toBe(201);
    });

    it("refuses a connection that holds the workspace below owner", async () => {
      mocks.getOauthTokenForRequest.mockResolvedValue(
        regularToken({
          granted_workspace_ids: ["workspace_torre"],
          granted_workspace_roles: { workspace_torre: "writer" },
        }),
      );
      const response = await action({
        request: jsonRequest({ workspace_id: "workspace_torre", name: "bugs" }),
      } as never);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("holds 'writer' on this workspace"),
      });
      expect(mocks.createDocoInWorkspace).not.toHaveBeenCalled();
    });

    it("refuses an all-workspaces connection capped below owner", async () => {
      mocks.getOauthTokenForRequest.mockResolvedValue({
        grant_type: "actor",
        actor_role: "writer",
      });
      const response = await action({
        request: jsonRequest({ workspace_id: "workspace_torre", name: "bugs" }),
      } as never);
      expect(response.status).toBe(403);
      expect(mocks.createDocoInWorkspace).not.toHaveBeenCalled();
    });

    it("refuses a connection limited to specific Docos, even inside the workspace", async () => {
      mocks.getOauthTokenForRequest.mockResolvedValue(
        regularToken({
          granted_doco_ids: ["doco_decisions"],
          granted_doco_roles: { doco_decisions: "owner" },
        }),
      );
      const response = await action({
        request: jsonRequest({ workspace_id: "workspace_torre", name: "bugs" }),
      } as never);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("doesn't cover this whole workspace"),
      });
      expect(mocks.createDocoInWorkspace).not.toHaveBeenCalled();
    });
  });
});
