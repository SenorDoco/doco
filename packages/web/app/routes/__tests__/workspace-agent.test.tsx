import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addWorkspaceByHandle = vi.fn();
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: vi.fn() }));
vi.mock("~/lib/redeem.server", () => ({
  addWorkspaceByHandle: (args: unknown) => addWorkspaceByHandle(args),
  ensurePersonalWorkspace: vi.fn(),
  findAvailableWorkspaceHandle: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: vi.fn(async () => ({ id: "user_alice", username: "alice" })),
}));

import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import { action as createWorkspace } from "../new-workspace";
import WorkspaceAgentPage from "../workspaces.$workspaceHandle.agent";

beforeEach(() => addWorkspaceByHandle.mockReset());

describe("after creating a workspace", () => {
  // Creating a workspace is step 1; the next thing the person needs is the
  // instructions to hand their agent, not the workspace's constitution.
  it("goes straight to connecting an agent to it", async () => {
    addWorkspaceByHandle.mockResolvedValue({ handle: "acme" });
    const body = new URLSearchParams({ handle: "acme" });
    const thrown = await createWorkspace({
      request: new Request("https://doco.test/new-workspace", { method: "POST", body }),
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/workspaces/acme/agent");
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
