import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  requireDocoTypeWriteForRequest: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  query: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(),
  runAuthoringPolicies: vi.fn(),
  reindexAndScheduleAttach: vi.fn(),
  appendAuditEvent: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, writer: 2, owner: 3 } as const;
  return {
    getEntity: mocks.getEntity,
    upsertEntity: (rec: unknown) => mocks.upsertEntity(rec),
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
    withClient: mocks.withClient,
    withTransaction: mocks.withTransaction,
  };
});

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  requireDocoTypeWriteForRequest: mocks.requireDocoTypeWriteForRequest,
}));

vi.mock("~/lib/authoring-runner.server", () => ({
  runAuthoringPolicies: mocks.runAuthoringPolicies,
}));

vi.mock("~/lib/audit-log.server", () => ({
  appendAuditEvent: mocks.appendAuditEvent,
}));

vi.mock("~/lib/capture.server", () => ({
  appendOperationTiming: (
    line: string,
    opts: { duration_ms?: number; authoringPoliciesPassed?: number },
  ) =>
    typeof opts.duration_ms === "number"
      ? `${line} (✅ ${opts.authoringPoliciesPassed ?? 0} authoring policies passed in ${(opts.duration_ms / 1000).toFixed(1)}s)`
      : line,
  authoringPoliciesPassed: (result: { passed?: number }) => result.passed ?? 0,
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
    mocks.withTransaction.mockImplementation((fn) => fn({ query: mocks.query }));
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "user_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "workspace_acme", docoId: "doco_acme" },
    });
    mocks.requireDocoTypeWriteForRequest.mockResolvedValue(null);
    mocks.getEntity.mockResolvedValue({
      id: PRINCIPAL_ID,
      doco_id: "doco_acme",
      entity_type: "principal",
      data: { node_type: "principal", name: "visitor" },
      summary: "Visitor",
      lifecycle: "asserted",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "user_admin",
    });
    mocks.runAuthoringPolicies.mockResolvedValue({
      evaluated: 0,
      passed: 0,
      blocking: null,
      warnings: [],
      violations: [],
    });
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
        updated_by: "user_author",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: PRINCIPAL_ID,
      lifecycle: "retired",
      footer_lines: [expect.stringContaining("Principal retired: [visitor]")],
    });
    expect(mocks.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        docoDir: "/tmp/docos/acme",
        docoId: "doco_acme",
        by: "user_author",
        entity_type: "principal",
        entity_id: PRINCIPAL_ID,
        op: "lifecycle.transition",
        before: expect.objectContaining({ lifecycle: "asserted" }),
        after: expect.objectContaining({ lifecycle: "retired" }),
      }),
    );
  });

  it("returns 409 when an active node still references the principal", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "action_01ABC",
          node_type: "action",
          summary: "Greet customer",
          edge_type: "attributed_to",
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
      error: expect.stringContaining("active nodes still reference it"),
      active_references: [expect.objectContaining({ id: "action_01ABC", node_type: "action" })],
    });
  });

  it("is idempotent when the principal is already retired", async () => {
    mocks.getEntity.mockResolvedValue({
      id: PRINCIPAL_ID,
      doco_id: "doco_acme",
      entity_type: "principal",
      data: { node_type: "principal", name: "visitor", lifecycle: "retired" },
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
      request: retireRequest({ lifecycle: "asserted" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("renames a Principal — name is editable", async () => {
    const response = await action({
      request: retireRequest({ name: "renamed" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PRINCIPAL_ID,
        entity_type: "principal",
        lifecycle: "asserted",
        data: expect.objectContaining({ name: "renamed" }),
        updated_by: "user_author",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: PRINCIPAL_ID,
      lifecycle: "asserted",
      footer_lines: [expect.stringContaining("Principal updated: [renamed]")],
    });
    expect(mocks.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "principal",
        entity_id: PRINCIPAL_ID,
        op: "entity.update",
        before: expect.objectContaining({ name: "visitor" }),
        after: expect.objectContaining({ name: "renamed" }),
      }),
    );
  });

  it("trims surrounding whitespace on a rename", async () => {
    const response = await action({
      request: retireRequest({ name: "  Renamed Seat  " }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Renamed Seat" }),
      }),
    );
  });

  it("rejects a blank name", async () => {
    const response = await action({
      request: retireRequest({ name: "   " }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("name must be a non-empty string"),
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

  it("requires principal write access", async () => {
    mocks.requireDocoTypeWriteForRequest.mockResolvedValue(
      Response.json(
        { error: "Forbidden: write access on 'principal' required to edit a principal." },
        { status: 403 },
      ),
    );

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
      data: { node_type: "principal", name: "visitor" },
      summary: "Visitor",
      lifecycle: "asserted",
    });

    const response = await action({
      request: retireRequest(),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(404);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
  });

  it("updates a Principal's body_md without lifecycle change", async () => {
    const response = await action({
      request: retireRequest({
        body_md: "Updated bio prose.",
      }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PRINCIPAL_ID,
        entity_type: "principal",
        lifecycle: "asserted",
        body_md: "Updated bio prose.",
        data: expect.objectContaining({
          name: "visitor",
          lifecycle: "asserted",
        }),
        updated_by: "user_author",
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
      lifecycle: "asserted",
      footer_lines: [expect.stringContaining("Principal updated: [visitor]")],
    });
    expect(mocks.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        docoDir: "/tmp/docos/acme",
        docoId: "doco_acme",
        by: "user_author",
        entity_type: "principal",
        entity_id: PRINCIPAL_ID,
        op: "entity.update",
        before: expect.objectContaining({ body_md: "" }),
        after: expect.objectContaining({ body_md: "Updated bio prose." }),
      }),
    );
  });

  it("rejects reports_to because reporting lines are edge-only", async () => {
    const response = await action({
      request: retireRequest({ reports_to: "principal_manager" }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to is not a node JSON field"),
    });
  });

  it("rejects clearing reports_to because edges are updated through the edge API", async () => {
    const response = await action({
      request: retireRequest({ reports_to: null }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to is not a node JSON field"),
    });
  });

  it("rejects self reports_to through the same edge-only guard", async () => {
    const response = await action({
      request: retireRequest({ reports_to: PRINCIPAL_ID }),
      params: { docoHandle: "acme", id: PRINCIPAL_ID } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to is not a node JSON field"),
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
      data: { node_type: "principal", name: "visitor" },
      body_md: "Human walking the public site. Operates under @alex.",
      lifecycle: "asserted",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "user_admin",
    });

    // Trigger the PATCH with a name-only edit so the patch doesn't supply
    // body_md. The handler must still
    // surface the EXISTING body_md to the policy evaluator from the
    // typed column, not silently drop it because it isn't in the
    // patch object.
    const response = await action({
      request: retireRequest({ name: "visitor" }),
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
      evaluated: 1,
      passed: 0,
      blocking: {
        reason: "Principal must declare person vs agent in body_md",
        policy_id: "policy_xyz",
      },
      violations: [],
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
