import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  requireDocoTypeWriteForRequest: vi.fn(),
  query: vi.fn(),
  upsertEntity: vi.fn(),
  withTransaction: vi.fn(),
  withClient: vi.fn(),
  getEntity: vi.fn(),
  runAuthoringPolicies: vi.fn(),
  reindexAndScheduleAttach: vi.fn(),
  appendAuditEvent: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, author: 2, writer: 2, approver: 3, owner: 4 } as const;
  return {
    getUserById: vi.fn(),
    getEntity: mocks.getEntity,
    getDocoById: vi.fn(async () => null),
    listDocoUsers: vi.fn(),
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
    upsertEntity: (rec: unknown) => mocks.upsertEntity(rec),
    withTransaction: mocks.withTransaction,
    withClient: mocks.withClient,
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
    mocks.withTransaction.mockImplementation((fn) => fn({ query: mocks.query }));
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "user_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "workspace_acme", docoId: "doco_acme" },
    });
    mocks.requireDocoTypeWriteForRequest.mockResolvedValue(null);
    mocks.runAuthoringPolicies.mockResolvedValue({
      evaluated: 0,
      passed: 0,
      blocking: null,
      warnings: [],
      violations: [],
    });
    mocks.reindexAndScheduleAttach.mockResolvedValue(undefined);
    mocks.getEntity.mockResolvedValue(null);
  });

  it("allows an author to create an arbitrary role principal", async () => {
    const response = await action({
      request: principalRequest({
        name: "Visitor",
        body_md: "Human site visitor — no Doco account required.",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.loadDocoRouteForRead).toHaveBeenCalledWith(
      expect.any(Request),
      { docoHandle: "acme" },
      "reader",
    );
    expect(mocks.requireDocoTypeWriteForRequest).toHaveBeenCalledWith(
      expect.any(Request),
      { ownerId: "workspace_acme", docoId: "doco_acme" },
      "user_author",
      "principal",
      "create a principal",
    );
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        doco_id: "doco_acme",
        entity_type: "principal",
        body_md: "Human site visitor — no Doco account required.",
        created_by: "user_author",
        updated_by: "user_author",
        data: expect.objectContaining({
          doco_id: "doco_acme",
          node_type: "principal",
          prose: "Visitor",
          created_by: "user_author",
          lifecycle: "active",
        }),
      }),
    );
    // The slim-down dropped display_name / description / type /
    // summary — confirm they no longer leak into data even when the
    // caller sends them.
    const persistedData = mocks.upsertEntity.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(persistedData).not.toHaveProperty("role_principal");
    expect(persistedData).not.toHaveProperty("display_name");
    expect(persistedData).not.toHaveProperty("description");
    expect(persistedData).not.toHaveProperty("type");
    expect(persistedData).not.toHaveProperty("summary");
    // upsertEntity is called WITHOUT a `summary` parameter.
    const upsertCall = mocks.upsertEntity.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertCall).not.toHaveProperty("summary");
    expect(mocks.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        docoDir: "/tmp/docos/acme",
        docoId: "doco_acme",
        by: "user_author",
        entity_type: "principal",
        entity_id: expect.stringMatching(/^principal_/),
        op: "entity.create",
        after: expect.objectContaining({
          name: "Visitor",
          body_md: "Human site visitor — no Doco account required.",
          lifecycle: "active",
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ ok: true, name: "Visitor" });
  });

  it("allows duplicate display names and non-slug-shaped names", async () => {
    const response = await action({
      request: principalRequest({
        name: "Alex Smith / Finance",
        body_md: "Human finance approver.",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("FROM principals WHERE name"),
      expect.anything(),
    );
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prose: "Alex Smith / Finance",
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      name: "Alex Smith / Finance",
      existed: false,
    });
  });

  it("passes body_md to the authoring policy evaluator (regression — was missing on POST)", async () => {
    // The org-chart template's "declare person-vs-agent in body_md"
    // probabilistic gate reads `candidate.body_md`. The first cut of
    // the POST handler built `raw` without `body_md` (it only wrote
    // the column on upsertEntity), so the policy evaluator never saw
    // the prose and rejected every Principal POST with valid prose.
    // This regression test asserts body_md reaches the evaluator.
    const response = await action({
      request: principalRequest({
        name: "gabriela",
        body_md: "Human director of the Buenos Aires team. Operates under @alex.",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.runAuthoringPolicies).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          prose: "gabriela",
          body_md: "Human director of the Buenos Aires team. Operates under @alex.",
        }),
      }),
    );
  });

  it("forwards a structured `kind` to the evaluator AND persists it on the node (filled seat declares human/agent)", async () => {
    // Post-slim-down the org-chart person/agent declaration is the structured
    // `kind` field. The route must forward it to the authoring evaluator (which
    // now keys the declaration off `kind`) AND persist it in the node data so
    // the org-tree icon and downstream reads see it.
    const response = await action({
      request: principalRequest({
        name: "reviewer-bot",
        body_md: "Pull-request reviewer for the platform repo.",
        kind: "agent",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.runAuthoringPolicies).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({ prose: "reviewer-bot", kind: "agent" }),
      }),
    );
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prose: "reviewer-bot", kind: "agent" }),
      }),
    );
  });

  it("rejects an invalid `kind` (must be human or agent when set)", async () => {
    const response = await action({
      request: principalRequest({ name: "weird", kind: "robot" }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/kind must be "human" or "agent"/i),
    });
  });

  it("omits `kind` for a vacant seat — a vacant seat declares no kind", async () => {
    const response = await action({
      request: principalRequest({
        name: "open-staff-seat",
        body_md: "Vacant — budgeted Staff Engineer seat, open req.",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    const persistedData = mocks.upsertEntity.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(persistedData).not.toHaveProperty("kind");
  });

  it("treats former reserved role-principal names as ordinary names", async () => {
    const response = await action({
      request: principalRequest({ name: "human" }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        body_md: "",
        data: expect.objectContaining({
          prose: "human",
          body_md: "",
        }),
      }),
    );
    // Slim-down: no `type` field anymore, and former reserved names do
    // not set role_principal.
    const persistedData = mocks.upsertEntity.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(persistedData).not.toHaveProperty("role_principal");
    expect(persistedData).not.toHaveProperty("type");
    expect(persistedData).not.toHaveProperty("summary");
  });

  it("rejects callers without principal write access even if they can read the Doco", async () => {
    mocks.requireDocoTypeWriteForRequest.mockResolvedValue(
      Response.json(
        { error: "Forbidden: write access on 'principal' required to create a principal." },
        { status: 403 },
      ),
    );

    const response = await action({
      request: principalRequest({ name: "visitor" }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(403);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden: write access on 'principal' required to create a principal.",
    });
  });

  it("rejects reports_to in principal JSON because reporting lines are edges", async () => {
    const response = await action({
      request: principalRequest({
        name: "alice",
        reports_to: "principal_manager",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.getEntity).not.toHaveBeenCalled();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to is not a node JSON field"),
    });
  });

  it("rejects reports_to before validating endpoint shape", async () => {
    const response = await action({
      request: principalRequest({
        name: "alice",
        reports_to: "decision_01ABC",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to is not a node JSON field"),
    });
  });

  it("rejects reports_to even when it looks like a principal id", async () => {
    const response = await action({
      request: principalRequest({
        name: "alice",
        reports_to: "principal_stranger",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.getEntity).not.toHaveBeenCalled();
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to is not a node JSON field"),
    });
  });
});
