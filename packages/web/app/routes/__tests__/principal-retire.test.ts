import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoLevelRole: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  query: vi.fn(),
  withClient: vi.fn(),
  runAuthoringPolicies: vi.fn(),
  reindexAndScheduleAttach: vi.fn(),
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

vi.mock("~/lib/authoring-runner.server", () => ({
  runAuthoringPolicies: mocks.runAuthoringPolicies,
}));

vi.mock("~/lib/capture.server", () => ({
  reindexAndScheduleAttach: mocks.reindexAndScheduleAttach,
}));

vi.mock("~/lib/db.server", () => ({
  docoPath: (handle: string) => `/tmp/docos/${handle}`,
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
      data: { neuron_type: "principal", name: "visitor" },
      summary: "Visitor",
      lifecycle: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "collaborator_admin",
    });
    mocks.runAuthoringPolicies.mockResolvedValue({ blocking: null, warnings: [] });
    mocks.reindexAndScheduleAttach.mockResolvedValue(undefined);
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
        data: expect.objectContaining({ lifecycle: "retired", name: "visitor" }),
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
      data: { neuron_type: "principal", name: "visitor", lifecycle: "retired" },
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

  it("rejects lifecycle values other than retired", async () => {
    const response = await action({
      request: retireRequest({ lifecycle: "active" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("rejects an attempt to patch the immutable name field", async () => {
    const response = await action({
      request: retireRequest({ name: "renamed" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unknown or immutable field(s)"),
    });
  });

  it("rejects an empty patch body", async () => {
    const response = await action({
      request: retireRequest({}),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Empty patch"),
    });
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
      data: { neuron_type: "principal", name: "visitor" },
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

  it("updates a Principal's summary + body_md without lifecycle change", async () => {
    const response = await action({
      request: retireRequest({
        summary: "A visitor with a new label.",
        body_md: "Updated bio prose.",
      }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PRINCIPAL_ID,
        entity_type: "principal",
        lifecycle: "active",
        body_md: "Updated bio prose.",
        summary: "A visitor with a new label.",
        data: expect.objectContaining({
          name: "visitor",
          summary: "A visitor with a new label.",
          lifecycle: "active",
        }),
        updated_by: "collaborator_author",
      }),
    );
    expect(mocks.reindexAndScheduleAttach).toHaveBeenCalledWith(
      expect.stringContaining("acme"),
      "doco_acme",
      PRINCIPAL_ID,
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: PRINCIPAL_ID,
      lifecycle: "active",
      footer_lines: [expect.stringContaining("Principal updated: visitor")],
    });
  });

  it("wires reports_to to an existing Principal in the same Doco", async () => {
    mocks.getEntity
      .mockResolvedValueOnce({
        id: "principal_manager",
        doco_id: "doco_acme",
        data: { neuron_type: "principal", name: "boss" },
      })
      .mockResolvedValueOnce({
        id: PRINCIPAL_ID,
        doco_id: "doco_acme",
        entity_type: "principal",
        data: { neuron_type: "principal", name: "visitor" },
        summary: "Visitor",
        lifecycle: "active",
      });

    const response = await action({
      request: retireRequest({ reports_to: "principal_manager" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "visitor",
          reports_to: "principal_manager",
        }),
      }),
    );
  });

  it("clears reports_to when null is passed (promotes to top-of-chain)", async () => {
    mocks.getEntity.mockResolvedValueOnce({
      id: PRINCIPAL_ID,
      doco_id: "doco_acme",
      entity_type: "principal",
      data: {
        neuron_type: "principal",
        name: "visitor",
        reports_to: "principal_old_manager",
      },
      summary: "Visitor",
      lifecycle: "active",
    });

    const response = await action({
      request: retireRequest({ reports_to: null }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    const upsertCall = mocks.upsertEntity.mock.calls[0]?.[0];
    expect(upsertCall.data).not.toHaveProperty("reports_to");
  });

  it("rejects a reports_to that points at the Principal itself", async () => {
    const response = await action({
      request: retireRequest({ reports_to: PRINCIPAL_ID }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("cannot point at the Principal itself"),
    });
  });

  it("surfaces body_md to the authoring policy evaluator (regression — was merged-from-data)", async () => {
    // body_md lives on its own text column on principals (not inside
    // data jsonb). The first cut of this handler built the candidate
    // by merging `existing.data` with the patch, so the candidate
    // never carried body_md — the org-chart "declare person-vs-agent
    // in body_md" probabilistic gate rejected every PATCH that didn't
    // re-supply body_md, even when the existing prose already
    // declared it.
    mocks.getEntity.mockResolvedValue({
      id: PRINCIPAL_ID,
      doco_id: "doco_acme",
      entity_type: "principal",
      data: { neuron_type: "principal", name: "visitor" },
      summary: "Visitor",
      body_md: "Human walking the public site. Operates under @alex.",
      lifecycle: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "collaborator_admin",
    });

    const response = await action({
      request: retireRequest({ summary: "Updated summary." }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.runAuthoringPolicies).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          name: "visitor",
          body_md: "Human walking the public site. Operates under @alex.",
        }),
      }),
    );
  });

  it("blocks an edit when an authoring policy is violating", async () => {
    mocks.runAuthoringPolicies.mockResolvedValue({
      blocking: {
        reason: "Principal must declare person vs agent in body_md",
        policy_id: "policy_xyz",
      },
      warnings: [],
    });

    const response = await action({
      request: retireRequest({ body_md: "Updated bio." }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(422);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Authoring policy violation"),
    });
  });
});
