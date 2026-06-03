import { describe, expect, it } from "vitest";
import {
  type ApprovalDocoOption,
  type ApprovalWorkspaceOption,
  approvalTargetNotOwnedMessage,
  boundWorkspaceNotOwnedMessage,
  parseWorkspaceFromResource,
  resolveApprovalGrantView,
  scopeApprovalToBoundWorkspace,
} from "../approval-grants";

const docos: ApprovalDocoOption[] = [
  {
    id: "doco_1",
    handle: "torre-bpms",
    my_role: "owner",
    workspace_id: "workspace_torre",
    workspace_label: "torre",
  },
  { id: "doco_2", handle: "solo", my_role: "owner", workspace_id: null, workspace_label: null },
];
const workspaces: ApprovalWorkspaceOption[] = [
  { id: "workspace_torre", handle: "torre", display_name: "Torre", my_role: "owner" },
];

describe("resolveApprovalGrantView", () => {
  it("offers the full matrix when no target is requested", () => {
    const v = resolveApprovalGrantView(docos, workspaces, null);
    expect(v.blocked).toBe(false);
    if (!v.blocked) {
      expect(v.docos).toEqual(docos);
      expect(v.workspaces).toEqual(workspaces);
    }
  });

  it("offers the full matrix when the target is a doco you own", () => {
    const v = resolveApprovalGrantView(docos, workspaces, "torre-bpms");
    expect(v.blocked).toBe(false);
    if (!v.blocked) {
      expect(v.docos).toEqual(docos); // not narrowed to just the target
      expect(v.workspaces).toEqual(workspaces); // workspace + account scopes preserved
    }
  });

  // A target you don't own is a TERMINAL error: granting some other doco
  // wouldn't satisfy the request, so the screen blocks the whole picker
  // rather than offering an unrelated matrix.
  it("blocks when the target is a doco you don't own", () => {
    const v = resolveApprovalGrantView(docos, workspaces, "doco-bpms");
    expect(v.blocked).toBe(true);
    if (v.blocked) expect(v.targetDocoHandle).toBe("doco-bpms");
  });
});

describe("approvalTargetNotOwnedMessage", () => {
  it("names the handle and points at the agent — not at picking an owned doco", () => {
    const m = approvalTargetNotOwnedMessage("doco-bpms");
    expect(m).toContain("doco-bpms");
    expect(m).toContain("agent");
    expect(m).not.toMatch(/client/i);
    expect(m).not.toMatch(/pick from/i);
  });
});

describe("parseWorkspaceFromResource", () => {
  it("extracts the workspace id from a per-workspace MCP resource", () => {
    expect(parseWorkspaceFromResource("https://doco.to/workspace_01ABC/mcp")).toBe(
      "workspace_01ABC",
    );
    expect(parseWorkspaceFromResource("https://doco.to/workspace_01ABC/mcp/")).toBe(
      "workspace_01ABC",
    );
  });

  it("returns null when the resource isn't a workspace MCP endpoint", () => {
    expect(parseWorkspaceFromResource(null)).toBeNull();
    expect(parseWorkspaceFromResource("")).toBeNull();
    expect(parseWorkspaceFromResource("https://doco.to/mcp")).toBeNull();
    expect(parseWorkspaceFromResource("https://doco.to/torre-bpms")).toBeNull();
  });
});

describe("scopeApprovalToBoundWorkspace", () => {
  // An MCP connector is bound to one workspace, so the consent must offer
  // ONLY that workspace (and its docos) — never the approver's others.
  it("narrows to just the bound workspace and its docos when the approver owns it", () => {
    const v = scopeApprovalToBoundWorkspace(docos, workspaces, "workspace_torre");
    expect(v.blocked).toBe(false);
    if (!v.blocked) {
      expect(v.boundWorkspace.id).toBe("workspace_torre");
      expect(v.workspaces).toEqual([workspaces[0]]);
      // doco_2 is personal (different workspace) and must not leak in.
      expect(v.docos.map((d) => d.id)).toEqual(["doco_1"]);
    }
  });

  it("blocks when the approver doesn't own the bound workspace", () => {
    const v = scopeApprovalToBoundWorkspace(docos, workspaces, "workspace_other");
    expect(v.blocked).toBe(true);
    if (v.blocked) expect(v.workspaceId).toBe("workspace_other");
  });
});

describe("boundWorkspaceNotOwnedMessage", () => {
  it("names the workspace it can't authorize", () => {
    const m = boundWorkspaceNotOwnedMessage("workspace_other");
    expect(m).toContain("workspace_other");
  });
});
