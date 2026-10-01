import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createWorkspace = vi.fn();
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: vi.fn() }));
vi.mock("~/lib/redeem.server", () => ({
  ensurePersonalWorkspace: vi.fn(),
  findAvailableWorkspaceHandle: vi.fn(),
}));
vi.mock("~/lib/workspace-create.server", () => ({
  createWorkspace: (args: unknown) => createWorkspace(args),
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: vi.fn(async () => ({ id: "user_alice", username: "alice" })),
}));

import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import { action as submitNewWorkspace } from "../new-workspace";
import WorkspaceAgentPage from "../workspaces.$workspaceHandle.agent";

beforeEach(() => createWorkspace.mockReset());

describe("after creating a workspace", () => {
  // Alexander, 2026-10-01: a new workspace walks its creator through three
  // steps on its own page, and its welcome email links there.
  it("goes to the workspace, whose steps set it up", async () => {
    createWorkspace.mockResolvedValue({ id: "workspace_acme", handle: "acme" });
    const body = new URLSearchParams({ handle: "acme" });
    const thrown = await submitNewWorkspace({
      request: new Request("https://doco.test/new-workspace", { method: "POST", body }),
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/workspaces/acme");
    expect(createWorkspace).toHaveBeenCalledWith({
      handle: "acme",
      ownerUserId: "user_alice",
      autoSuffix: false,
    });
  });
});

describe("/workspaces/:handle/agent", () => {
  const instructions = agentInstructionsForWorkspace("https://doco.test", "acme");
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(WorkspaceAgentPage, {
        loaderData: {
          me: { id: "user_alice", username: "alice" },
          workspace: { handle: "acme" },
          instructions,
        } as never,
      }),
    ),
  );

  it("hands over instructions that already name the workspace, with a Copy button", () => {
    expect(html).toContain("Connect your agent to acme");
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("Doco workspace: https://doco.test/workspaces/acme");
  });

  it("links on to the workspace", () => {
    expect(html).toContain('href="/workspaces/acme"');
  });
});
