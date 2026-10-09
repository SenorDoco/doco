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

vi.mock("~/lib/workspace-create.server", () => ({ createWorkspace: vi.fn() }));
vi.mock("~/lib/redeem.server", () => ({
  createDocoInWorkspace: mocks.createDocoInWorkspace,
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

  it("continues GitHub bugs Doco creation into picking the repositories to bring bugs from", async () => {
    mocks.createDocoInWorkspace.mockResolvedValue({ docoId: "doco_5", handle: "acme-github-bugs" });
    const response = (await action({
      request: postNewDoco({
        template_handle: "github-bugs",
        workspace_id: "workspace_1",
        name: "acme-github-bugs",
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/acme-github-bugs/integrations/github");
  });

  it("continues codebase Doco creation into picking the repositories to copy", async () => {
    mocks.createDocoInWorkspace.mockResolvedValue({ docoId: "doco_4", handle: "acme-codebase" });
    const response = (await action({
      request: postNewDoco({
        template_handle: "codebase",
        workspace_id: "workspace_1",
        name: "acme-codebase",
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/acme-codebase/integrations/github");
  });

  it("continues Slack Doco creation into turning on the Slack mirror", async () => {
    mocks.createDocoInWorkspace.mockResolvedValue({ docoId: "doco_2", handle: "acme-slack" });
    const response = (await action({
      request: postNewDoco({
        template_handle: "slack",
        workspace_id: "workspace_1",
        name: "acme-slack",
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/acme-slack/integrations/slack");
  });

  it("continues Notion Doco creation into turning on the Notion mirror", async () => {
    mocks.createDocoInWorkspace.mockResolvedValue({ docoId: "doco_3", handle: "acme-notion" });
    const response = (await action({
      request: postNewDoco({
        template_handle: "notion",
        workspace_id: "workspace_1",
        name: "acme-notion",
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/acme-notion/integrations/notion");
  });
});
