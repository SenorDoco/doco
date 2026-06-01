import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addOrganizationByHandle: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  tokenReachableOrgIdsForRequest: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  listOrganizationsForUser: mocks.listOrganizationsForUser,
}));

vi.mock("~/lib/doco-access.server", () => ({
  tokenReachableOrgIdsForRequest: mocks.tokenReachableOrgIdsForRequest,
}));

vi.mock("~/lib/redeem.server", () => ({
  addOrganizationByHandle: mocks.addOrganizationByHandle,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

import { loader } from "../api.v1.orgs[.]json";

const ORGS = [
  { id: "organization_torre", handle: "torre", name: "Torre", member_count: 3 },
  { id: "organization_meta", handle: "meta-doco", name: "Meta Doco", member_count: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice", username: "alice" });
  mocks.listOrganizationsForUser.mockResolvedValue(ORGS);
});

describe("GET /api/v1/orgs.json", () => {
  it("lists every membership org for a cookie session (no token scope-down)", async () => {
    mocks.tokenReachableOrgIdsForRequest.mockResolvedValue(null);
    const request = new Request("https://doco.test/api/v1/orgs.json");
    const response = await loader({ request } as never);
    const body = (await response.json()) as { orgs: { id: string; handle: string }[] };
    expect(body.orgs.map((o) => o.handle)).toEqual(["meta-doco", "torre"]);
  });

  it("hides orgs the OAuth token cannot reach (cross-org leak fix)", async () => {
    mocks.tokenReachableOrgIdsForRequest.mockResolvedValue(new Set(["organization_torre"]));
    const request = new Request("https://doco.test/api/v1/orgs.json", {
      headers: { Authorization: "Bearer doco_at_x" },
    });
    const response = await loader({ request } as never);
    const body = (await response.json()) as { orgs: { id: string }[] };
    expect(body.orgs.map((o) => o.id)).toEqual(["organization_torre"]);
  });
});
