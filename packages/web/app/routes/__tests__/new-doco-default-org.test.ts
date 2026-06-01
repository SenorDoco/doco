import { describe, expect, it, vi } from "vitest";

// The route module imports server-only helpers at module load; mock them
// so importing the pure selection helper here never touches the DB.
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: vi.fn() }));
vi.mock("~/lib/org-helpers.server", () => ({
  isOrgMember: vi.fn(),
  listMyOrgs: vi.fn(),
  lookupOrgHandle: vi.fn(),
}));
vi.mock("~/lib/redeem.server", () => ({
  addOrganizationByHandle: vi.fn(),
  createDocoInOrg: vi.fn(),
  ensurePersonalOrganization: vi.fn(),
  findAvailableDocoHandle: vi.fn(),
}));

import { CREATE_NEW_ORG_VALUE, initialOrgSelection } from "../new-doco";

describe("/new-doco initial organization selection", () => {
  it("does not pre-select any organization on a fresh form", () => {
    // Regression: the form used to default to orgs[0]?.id, auto-selecting
    // the user's first org. A fresh form must start unselected so the
    // user makes a deliberate choice.
    expect(initialOrgSelection({ orgId: "", newOrgHandle: "" })).toBe("");
  });

  it("keeps an explicitly chosen org (URL prefill or error re-render)", () => {
    expect(initialOrgSelection({ orgId: "organization_7", newOrgHandle: "" })).toBe(
      "organization_7",
    );
  });

  it("restores create-new-org mode when a new handle was entered", () => {
    expect(initialOrgSelection({ orgId: "", newOrgHandle: "acme" })).toBe(CREATE_NEW_ORG_VALUE);
  });
});
