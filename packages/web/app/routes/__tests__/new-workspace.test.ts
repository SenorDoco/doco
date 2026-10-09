import { beforeEach, describe, expect, it, vi } from "vitest";

const createWorkspace = vi.fn();
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: vi.fn() }));
vi.mock("~/lib/redeem.server", () => ({
  findAvailableWorkspaceHandle: vi.fn(),
}));
vi.mock("~/lib/workspace-create.server", () => ({
  createWorkspace: (args: unknown) => createWorkspace(args),
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: vi.fn(async () => ({ id: "user_alice", username: "alice" })),
}));

import { action as submitNewWorkspace } from "../new-workspace";

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
