import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoLevelRole: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, author: 2, approver: 3, owner: 4 } as const;
  return {
    getEntity: mocks.getEntity,
    upsertEntity: mocks.upsertEntity,
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
    withClient: mocks.withClient,
  };
});

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
}));

import { action } from "../$docoHandle.api.principals.$id[.]json";

function retireRequest(body: Record<string, unknown> = { lifecycle: "retired" }): Request {
  return new Request("https://doco.test/acme/api/principals/principal_xyz.json", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PRINCIPAL_ID = "principal_xyz";

describe("principal retire API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.withClient.mockImplementation((fn) => fn({ query: mocks.query }));
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "collaborator_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "organization_acme", docoId: "doco_acme" },
    });
    mocks.getDocoLevelRole.mockResolvedValue("author");
    mocks.getEntity.mockResolvedValue({
      id: PRINCIPAL_ID,
      doco_id: "doco_acme",
      entity_type: "principal",
      data: { neuron_type: "principal", username: "visitor" },
      summary: "Visitor",
      lifecycle: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "collaborator_admin",
    });
  });

  it("retires an unreferenced principal", async () => {
    const response = await action({
      request: retireRequest(),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PRINCIPAL_ID,
        entity_type: "principal",
        lifecycle: "retired",
        data: expect.objectContaining({ lifecycle: "retired", username: "visitor" }),
        updated_by: "collaborator_author",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: PRINCIPAL_ID,
      lifecycle: "retired",
      footer_lines: [expect.stringContaining("Principal retired: visitor")],
    });
  });

  it("returns 409 when an active neuron still references the principal", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "action_01ABC",
          neuron_type: "action",
          summary: "Greet customer",
          synapse_type: "performed_by",
        },
      ],
    });

    const response = await action({
      request: retireRequest(),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(409);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("active neurons still reference it"),
      active_references: [expect.objectContaining({ id: "action_01ABC", neuron_type: "action" })],
    });
  });

  it("is idempotent when the principal is already retired", async () => {
    mocks.getEntity.mockResolvedValue({
      id: PRINCIPAL_ID,
      doco_id: "doco_acme",
      entity_type: "principal",
      data: { neuron_type: "principal", username: "visitor", lifecycle: "retired" },
      summary: "Visitor",
      lifecycle: "retired",
    });

    const response = await action({
      request: retireRequest(),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      already_retired: true,
    });
  });

  it("rejects body patches other than lifecycle=retired", async () => {
    const response = await action({
      request: retireRequest({ lifecycle: "active" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("requires author role", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");

    const response = await action({
      request: retireRequest(),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(403);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("404s when the principal isn't in this Doco", async () => {
    mocks.getEntity.mockResolvedValue({
      id: PRINCIPAL_ID,
      doco_id: "doco_other",
      entity_type: "principal",
      data: { neuron_type: "principal", username: "visitor" },
      summary: "Visitor",
      lifecycle: "active",
    });

    const response = await action({
      request: retireRequest(),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(404);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });
});
