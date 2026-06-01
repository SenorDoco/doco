import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addOrganizationByHandle: vi.fn(),
  createDocoInOrg: vi.fn(),
  ensurePersonalOrganization: vi.fn(),
  findAvailableDocoHandle: vi.fn(),
  getCurrentPrincipal: vi.fn(),
  isOrgMember: vi.fn(),
  listMyOrgs: vi.fn(),
  lookupOrgHandle: vi.fn(),
}));

vi.mock("~/lib/org-helpers.server", () => ({
  isOrgMember: mocks.isOrgMember,
  listMyOrgs: mocks.listMyOrgs,
  lookupOrgHandle: mocks.lookupOrgHandle,
}));

vi.mock("~/lib/redeem.server", () => ({
  addOrganizationByHandle: mocks.addOrganizationByHandle,
  createDocoInOrg: mocks.createDocoInOrg,
  ensurePersonalOrganization: mocks.ensurePersonalOrganization,
  findAvailableDocoHandle: mocks.findAvailableDocoHandle,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

import { action } from "../new-doco";

function formRequest(body: Record<string, string>): Request {
  return new Request("https://doco.test/new-doco", {
    method: "POST",
    body: new URLSearchParams(body),
  });
}

async function expectRedirect(promise: Promise<unknown>): Promise<Response> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    return e as Response;
  }
  throw new Error("Expected action to throw a redirect Response.");
}

describe("/new-doco", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.isOrgMember.mockResolvedValue(true);
    mocks.lookupOrgHandle.mockResolvedValue("acme");
  });

  it("takes GitHub pull request docos straight to the GitHub integration page", async () => {
    mocks.createDocoInOrg.mockResolvedValue({
      docoId: "doco_01KSJZ35Y5H6HA7WF75JWMY7J4",
      handle: "prs",
      orgId: "org_acme",
      orgHandle: "acme",
      goal: "Track pull requests.",
      companionChatId: null,
    });

    const response = await expectRedirect(
      action({
        request: formRequest({
          template_handle: "github-pull-requests",
          org_id: "org_acme",
          name: "prs",
          visibility: "private",
          goal: "Track pull requests.",
        }),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/prs/integrations/github");
  });
});
