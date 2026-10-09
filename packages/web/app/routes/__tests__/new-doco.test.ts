import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  createDocoInWorkspace: vi.fn(),
  findAvailableDocoHandle: vi.fn(),
  getCurrentPrincipal: vi.fn(),
  isWorkspaceMember: vi.fn(),
  listMyWorkspaces: vi.fn(),
  lookupWorkspaceHandle: vi.fn(),
}));

vi.mock("~/lib/workspace-helpers.server", () => ({
  isWorkspaceMember: mocks.isWorkspaceMember,
  listMyWorkspaces: mocks.listMyWorkspaces,
  lookupWorkspaceHandle: mocks.lookupWorkspaceHandle,
}));

vi.mock("~/lib/redeem.server", () => ({
  createDocoInWorkspace: mocks.createDocoInWorkspace,
  findAvailableDocoHandle: mocks.findAvailableDocoHandle,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/workspace-create.server", () => ({
  createWorkspace: mocks.createWorkspace,
}));

import { action } from "../new-doco";

function formRequest(body: Record<string, string>): Request {
  return new Request("https://doco.test/new-doco", {
    method: "POST",
    body: new URLSearchParams(body),
  });
}

async function expectRedirect(promise: Promise<unknown>): Promise<Response> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    return e as Response;
  }
  throw new Error("Expected action to throw a redirect Response.");
}

describe("/new-doco", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.isWorkspaceMember.mockResolvedValue(true);
    mocks.lookupWorkspaceHandle.mockResolvedValue("acme");
  });

  it("starts the GitHub connection flow for GitHub pull request docos", async () => {
    mocks.createDocoInWorkspace.mockResolvedValue({
      docoId: "doco_01KSJZ35Y5H6HA7WF75JWMY7J4",
      handle: "prs",
      workspaceId: "workspace_acme",
      workspaceHandle: "acme",
      goal: "Track pull requests.",
    });

    const response = await expectRedirect(
      action({
        request: formRequest({
          template_handle: "github-pull-requests",
          workspace_id: "workspace_acme",
          name: "prs",
          visibility: "private",
          goal: "Track pull requests.",
        }),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/prs/integrations/github");
  });

  it("asks for a template when none was chosen", async () => {
    const result = await action({
      request: formRequest({ workspace_id: "workspace_acme", name: "bpms", visibility: "private" }),
    });

    expect(result).toMatchObject({
      error: "Pick a template, or Generic (empty) for a blank doco.",
    });
    expect(mocks.createDocoInWorkspace).not.toHaveBeenCalled();
  });

  it("redirects regular docos without a created chat id", async () => {
    mocks.createDocoInWorkspace.mockResolvedValue({
      docoId: "doco_01KSJZ35Y5H6HA7WF75JWMY7J4",
      handle: "bpms",
      workspaceId: "workspace_acme",
      workspaceHandle: "acme",
      goal: "Track process work.",
    });

    const response = await expectRedirect(
      action({
        request: formRequest({
          template_handle: "generic",
          workspace_id: "workspace_acme",
          name: "bpms",
          visibility: "private",
          goal: "Track process work.",
        }),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/bpms/welcome?created_doco_id=doco_01KSJZ35Y5H6HA7WF75JWMY7J4",
    );
  });
});
