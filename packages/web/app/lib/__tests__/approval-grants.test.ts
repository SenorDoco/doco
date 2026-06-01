import { describe, expect, it } from "vitest";
import {
  type ApprovalDocoOption,
  type ApprovalOrgOption,
  resolveApprovalGrantView,
} from "../approval-grants";

const docos: ApprovalDocoOption[] = [
  {
    id: "doco_1",
    handle: "torre-bpms",
    my_role: "owner",
    org_id: "organization_torre",
    org_label: "torre",
  },
  { id: "doco_2", handle: "solo", my_role: "owner", org_id: null, org_label: null },
];
const orgs: ApprovalOrgOption[] = [
  { id: "organization_torre", handle: "torre", display_name: "Torre", my_role: "owner" },
];

describe("resolveApprovalGrantView", () => {
  it("returns the full matrix, no notice, when no target is requested", () => {
    const v = resolveApprovalGrantView(docos, orgs, null);
    expect(v.docos).toEqual(docos);
    expect(v.orgs).toEqual(orgs);
    expect(v.targetedMessage).toBeNull();
  });

  // The point of the change: the SAME matrix everywhere. A requested
  // target must not strip orgs (account/org scopes) nor narrow the doco
  // list. Previously a target did both, so the approve screen lost its
  // account and organization scopes.
  it("keeps the full matrix when the target matches an owned doco", () => {
    const v = resolveApprovalGrantView(docos, orgs, "torre-bpms");
    expect(v.docos).toEqual(docos); // not narrowed to just the target
    expect(v.orgs).toEqual(orgs); // org + account scopes preserved
    expect(v.targetedMessage).toBeNull();
  });

  it("keeps the full matrix and adds a notice when the target isn't owned", () => {
    const v = resolveApprovalGrantView(docos, orgs, "doco-bpms");
    expect(v.docos).toEqual(docos);
    expect(v.orgs).toEqual(orgs); // still offers every org you can grant
    expect(v.targetedMessage).toContain("doco-bpms");
    expect(v.targetedMessage).toContain("you don't own that Doco");
  });
});
