import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  isOrgMember: vi.fn(),
  lookupOrgHandle: vi.fn(),
  createDocoInOrg: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/org-helpers.server", () => ({
  isOrgMember: mocks.isOrgMember,
  listMyOrgs: vi.fn(),
  lookupOrgHandle: mocks.lookupOrgHandle,
}));

vi.mock("~/lib/redeem.server", () => ({
  addOrganizationByHandle: vi.fn(),
  createDocoInOrg: mocks.createDocoInOrg,
  ensurePersonalOrganization: vi.fn(),
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
    mocks.isOrgMember.mockResolvedValue(true);
    mocks.lookupOrgHandle.mockResolvedValue("acme");
    mocks.createDocoInOrg.mockResolvedValue({
      docoId: "doco_1",
      handle: "acme-prs",
    });
  });

  it("continues first-time PR Doco creation into the GitHub connection flow", async () => {
    const response = (await action({
      request: postNewDoco({
        template_handle: "github-pull-requests",
        org_id: "organization_1",
        name: "acme-prs",
      }),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/acme-prs/integrations/github");
  });
});
