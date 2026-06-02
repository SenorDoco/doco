import { describe, expect, it } from "vitest";
import {
  type ApprovalDocoOption,
  type ApprovalWorkspaceOption,
  approvalTargetNotOwnedMessage,
  resolveApprovalGrantView,
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
