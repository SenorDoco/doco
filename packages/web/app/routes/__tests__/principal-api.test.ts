import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoLevelRole: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  query: vi.fn(),
  upsertEntity: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, author: 2, approver: 3, owner: 4 } as const;
  return {
    getCollaboratorById: vi.fn(),
    listDocoUsers: vi.fn(),
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
    upsertEntity: mocks.upsertEntity,
    withClient: mocks.withClient,
  };
});

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
}));

import { action } from "../$docoHandle.api.principals[.]json";

function principalRequest(body: Record<string, unknown>): Request {
  return new Request("https://doco.test/acme/api/principals.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("principal API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.withClient.mockImplementation((fn) => fn({ query: mocks.query }));
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "collaborator_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "organization_acme", docoId: "doco_acme" },
    });
    mocks.getDocoLevelRole.mockResolvedValue("author");
  });

  it("allows an author to create an arbitrary role principal", async () => {
    const response = await action({
      request: principalRequest({
        name: "Visitor",
        display_name: "Visitor",
        description: "Someone browsing the public site.",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.loadDocoRouteForRead).toHaveBeenCalledWith(
      expect.any(Request),
      { docoHandle: "acme" },
      "author",
    );
    expect(mocks.getDocoLevelRole).toHaveBeenCalledWith(
      { ownerId: "organization_acme", docoId: "doco_acme" },
      "collaborator_author",
    );
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        doco_id: "doco_acme",
        entity_type: "principal",
        summary: "Visitor",
        created_by: "collaborator_author",
        updated_by: "collaborator_author",
        data: expect.objectContaining({
          doco_id: "doco_acme",
          neuron_type: "principal",
          name: "visitor",
          display_name: "Visitor",
          description: "Someone browsing the public site.",
          created_by: "collaborator_author",
          lifecycle: "active",
        }),
      }),
    );
    expect(mocks.upsertEntity.mock.calls[0]?.[0].data).not.toHaveProperty("role_principal");
    await expect(response.json()).resolves.toMatchObject({ ok: true, name: "visitor" });
  });

  it("keeps the built-in role-principal defaults", async () => {
    const response = await action({
      request: principalRequest({ name: "human" }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Role principal for the person-only subset of users.",
        data: expect.objectContaining({
          name: "human",
          role_principal: true,
          type: "person",
        }),
      }),
    );
  });

  it("rejects collaborators below author even if they can read the Doco", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");

    const response = await action({
      request: principalRequest({ name: "visitor" }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(403);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden: author role required to create a principal.",
    });
  });
});
