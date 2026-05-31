import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  resolveOrgByHandle: vi.fn(),
  getOrgRole: vi.fn(),
  loadOrgIntegrationsRollup: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/org-helpers.server", () => ({
  resolveOrgByHandle: mocks.resolveOrgByHandle,
}));

vi.mock("@doco/db", () => ({
  getOrgRole: mocks.getOrgRole,
}));

vi.mock("~/lib/integrations-summary.server", () => ({
  loadOrgIntegrationsRollup: mocks.loadOrgIntegrationsRollup,
}));

import { loader } from "../orgs.$orgHandle.integrations";

describe("/orgs/:orgHandle/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadOrgIntegrationsRollup.mockResolvedValue({
      orgId: "organization_acme",
      orgHandle: "acme",
      docos: [],
    });
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/orgs/acme/integrations"),
      params: { orgHandle: "acme" },
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in?next=%2Forgs%2Facme%2Fintegrations");
  });

  it("returns 404 for a missing org", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveOrgByHandle.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/orgs/missing/integrations"),
      params: { orgHandle: "missing" },
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(404);
  });

  it("returns 403 when the user has no role in the org", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveOrgByHandle.mockResolvedValue({
      id: "organization_acme",
      handle: "acme",
      constitution: "",
    });
    mocks.getOrgRole.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/orgs/acme/integrations"),
      params: { orgHandle: "acme" },
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(403);
  });

  it("loads the org rollup for members", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.resolveOrgByHandle.mockResolvedValue({
      id: "organization_acme",
      handle: "acme",
      constitution: "",
    });
    mocks.getOrgRole.mockResolvedValue("owner");
    const rollup = {
      orgId: "organization_acme",
      orgHandle: "acme",
      docos: [
        {
          docoId: "doco_one",
          handle: "acme-one",
          orgHandle: "acme",
          githubRepoCount: 1,
        },
      ],
    };
    mocks.loadOrgIntegrationsRollup.mockResolvedValue(rollup);

    const data = await loader({
      request: new Request("https://doco.test/orgs/acme/integrations"),
      params: { orgHandle: "acme" },
    });

    expect(data.me).toEqual({ id: "user_alice", username: "alice" });
    expect(data.org).toEqual({
      id: "organization_acme",
      handle: "acme",
      constitution: "",
    });
    expect(data.rollup).toEqual(rollup);
  });
});
