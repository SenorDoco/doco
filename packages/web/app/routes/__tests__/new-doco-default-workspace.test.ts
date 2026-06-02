import { describe, expect, it, vi } from "vitest";

// The route module imports server-only helpers at module load; mock them
// so importing the pure selection helper here never touches the DB.
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: vi.fn() }));
vi.mock("~/lib/workspace-helpers.server", () => ({
  isWorkspaceMember: vi.fn(),
  listMyWorkspaces: vi.fn(),
  lookupWorkspaceHandle: vi.fn(),
}));
vi.mock("~/lib/redeem.server", () => ({
  addWorkspaceByHandle: vi.fn(),
  createDocoInWorkspace: vi.fn(),
  ensurePersonalWorkspace: vi.fn(),
  findAvailableDocoHandle: vi.fn(),
}));

import { CREATE_NEW_ORG_VALUE, initialWorkspaceSelection } from "../new-doco";

describe("/new-doco initial workspace selection", () => {
  it("does not pre-select any workspace on a fresh form", () => {
    // Regression: the form used to default to workspaces[0]?.id, auto-selecting
    // the user's first workspace. A fresh form must start unselected so the
    // user makes a deliberate choice.
    expect(initialWorkspaceSelection({ workspaceId: "", newWorkspaceHandle: "" })).toBe("");
  });

  it("keeps an explicitly chosen workspace (URL prefill or error re-render)", () => {
    expect(initialWorkspaceSelection({ workspaceId: "workspace_7", newWorkspaceHandle: "" })).toBe(
      "workspace_7",
    );
  });

  it("restores create-new-workspace mode when a new handle was entered", () => {
    expect(initialWorkspaceSelection({ workspaceId: "", newWorkspaceHandle: "acme" })).toBe(
      CREATE_NEW_ORG_VALUE,
    );
  });
});
