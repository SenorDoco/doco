import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDocoInOrg: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  getOrgRole: vi.fn(),
  listVisibleDocoIdsForRequest: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getOrgRole: mocks.getOrgRole,
  roleAtLeast: (role: string | null, threshold: string) => {
    const rank: Record<string, number> = { reader: 0, author: 1, approver: 2, owner: 3 };
    return role !== null && rank[role] >= rank[threshold];
  },
  withClient: (fn: (client: { query: typeof mocks.query }) => unknown) =>
    fn({ query: mocks.query }),
}));

vi.mock("~/lib/doco-access.server", () => ({
  listVisibleDocoIdsForRequest: mocks.listVisibleDocoIdsForRequest,
}));

vi.mock("~/lib/redeem.server", () => ({
  createDocoInOrg: mocks.createDocoInOrg,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

import { action, loader } from "../api.v1.docos[.]json";

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://doco.test/api/v1/docos.json", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/v1/docos.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
  });

  it("lists qualified org/doco handles", async () => {
    mocks.listVisibleDocoIdsForRequest.mockResolvedValue(["doco_bpms"]);
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "doco_bpms",
          handle: "bpms",
          org_id: "organization_torre",
          org_handle: "torre",
        },
      ],
    });

    const response = await loader({ request: jsonRequest(undefined, "GET") } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      docos: [
        {
          id: "doco_bpms",
          handle: "bpms",
          org_id: "organization_torre",
          org_handle: "torre",
          qualified_handle: "torre/bpms",
        },
      ],
    });
  });

  it("requires owner on the target org to create a doco", async () => {
    mocks.getOrgRole.mockResolvedValue("writer");

    const response = await action({
      request: jsonRequest({ org_id: "organization_torre", name: "bpms" }),
    } as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Only org owners can create docos -- you hold 'writer' on this org.",
    });
    expect(mocks.createDocoInOrg).not.toHaveBeenCalled();
  });

  it("creates a doco for org owners and returns the qualified handle", async () => {
    mocks.getOrgRole.mockResolvedValue("owner");
    mocks.createDocoInOrg.mockResolvedValue({
      docoId: "doco_bpms",
      handle: "bpms",
      orgId: "organization_torre",
      orgHandle: "torre",
      goal: "Process memory.",
    });

    const response = await action({
      request: jsonRequest({ org_id: "organization_torre", name: "BPMS", privacy: "public" }),
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "doco_bpms",
      handle: "bpms",
      org_handle: "torre",
      org_id: "organization_torre",
      qualified_handle: "torre/bpms",
      template_handle: "generic",
      visibility: "public",
      goal: "Process memory.",
    });
    expect(mocks.createDocoInOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "organization_torre",
        requestedHandle: "bpms",
        createdByUserId: "user_alice",
      }),
    );
  });

  it("accepts the common template alias and returns the applied template handle", async () => {
    mocks.getOrgRole.mockResolvedValue("owner");
    mocks.createDocoInOrg.mockResolvedValue({
      docoId: "doco_glossary",
      handle: "glossary",
      orgId: "organization_torre",
      orgHandle: "torre",
      goal: "Glossary memory.",
    });

    const response = await action({
      request: jsonRequest({
        org_id: "organization_torre",
        name: "Glossary",
        template: "glossaries",
      }),
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "doco_glossary",
      handle: "glossary",
      org_handle: "torre",
      org_id: "organization_torre",
      qualified_handle: "torre/glossary",
      template_handle: "glossaries",
      visibility: "private",
      goal: "Glossary memory.",
    });
    expect(mocks.createDocoInOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "organization_torre",
        requestedHandle: "glossary",
        createdByUserId: "user_alice",
        templateHandle: "glossaries",
      }),
    );
  });
});
