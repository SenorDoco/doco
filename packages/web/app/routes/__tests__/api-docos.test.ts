import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDocoInWorkspace: vi.fn(),
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
      docoId: "doco_glossary",
      handle: "glossary",
      workspaceId: "workspace_torre",
      workspaceHandle: "torre",
      goal: "Glossary memory.",
    });

    const response = await action({
      request: jsonRequest({
        workspace_id: "workspace_torre",
        name: "Glossary",
        template: "glossaries",
      }),
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "doco_glossary",
      handle: "glossary",
      workspace_handle: "torre",
      workspace_id: "workspace_torre",
      qualified_handle: "torre/glossary",
      template_handle: "glossaries",
      visibility: "private",
      goal: "Glossary memory.",
    });
    expect(mocks.createDocoInWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_torre",
        requestedHandle: "glossary",
        createdByUserId: "user_alice",
        templateHandle: "glossaries",
      }),
    );
  });
});
