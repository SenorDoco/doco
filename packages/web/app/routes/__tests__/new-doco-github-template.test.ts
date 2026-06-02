import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  isWorkspaceMember: vi.fn(),
  lookupWorkspaceHandle: vi.fn(),
  createDocoInWorkspace: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/workspace-helpers.server", () => ({
  isWorkspaceMember: mocks.isWorkspaceMember,
  listMyWorkspaces: vi.fn(),
  lookupWorkspaceHandle: mocks.lookupWorkspaceHandle,
}));

vi.mock("~/lib/redeem.server", () => ({
  addWorkspaceByHandle: vi.fn(),
  createDocoInWorkspace: mocks.createDocoInWorkspace,
  ensurePersonalWorkspace: vi.fn(),
  findAvailableDocoHandle: vi.fn(),
}));

import { action } from "../new-doco";

function postNewDoco(body: Record<string, string>): Request {
  return new Request("https://doco.test/new-doco", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

describe("/new-doco GitHub PR template", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_1", username: "alice" });
    mocks.isWorkspaceMember.mockResolvedValue(true);
    mocks.lookupWorkspaceHandle.mockResolvedValue("acme");
    mocks.createDocoInWorkspace.mockResolvedValue({
      docoId: "doco_1",
      handle: "acme-prs",
    });
  });

  it("continues first-time PR Doco creation into the GitHub connection flow", async () => {
    const response = (await action({
      request: postNewDoco({
        template_handle: "github-pull-requests",
        workspace_id: "workspace_1",
        name: "acme-prs",
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/acme-prs/integrations/github");
  });
});
