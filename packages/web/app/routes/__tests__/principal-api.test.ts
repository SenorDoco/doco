import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoLevelRole: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  query: vi.fn(),
  upsertEntity: vi.fn(),
  withClient: vi.fn(),
  getEntity: vi.fn(),
  runAuthoringPolicies: vi.fn(),
  reindexAndScheduleAttach: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, author: 2, approver: 3, owner: 4 } as const;
  return {
    getCollaboratorById: vi.fn(),
    getEntity: mocks.getEntity,
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

vi.mock("~/lib/authoring-runner.server", () => ({
  runAuthoringPolicies: mocks.runAuthoringPolicies,
}));

vi.mock("~/lib/capture.server", () => ({
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
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "collaborator_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "organization_acme", docoId: "doco_acme" },
    });
    mocks.getDocoLevelRole.mockResolvedValue("author");
    mocks.runAuthoringPolicies.mockResolvedValue({ blocking: null, warnings: [] });
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
        body_md: "Human site visitor — no Doco account required.",
        created_by: "collaborator_author",
        updated_by: "collaborator_author",
        data: expect.objectContaining({
          doco_id: "doco_acme",
          neuron_type: "principal",
          name: "visitor",
          created_by: "collaborator_author",
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
    // upsertEntity is called WITHOUT a `summary` parameter — migration
    // 037 dropped the column.
    const upsertCall = mocks.upsertEntity.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertCall).not.toHaveProperty("summary");
    await expect(response.json()).resolves.toMatchObject({ ok: true, name: "visitor" });
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
          name: "gabriela",
          body_md: "Human director of the Buenos Aires team. Operates under @alex.",
        }),
      }),
    );
  });

  it("keeps the built-in role-principal defaults", async () => {
    const response = await action({
      request: principalRequest({ name: "human" }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        // Default body_md is now the reserved-role explainer that used
        // to seed `summary` — migration 037 removed the summary column.
        body_md: "Role principal for the person-only subset of users.",
        data: expect.objectContaining({
          name: "human",
          role_principal: true,
          body_md: "Role principal for the person-only subset of users.",
        }),
      }),
    );
    // Slim-down: no `type` field anymore even for reserved role names.
    const persistedData = mocks.upsertEntity.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(persistedData).not.toHaveProperty("type");
    expect(persistedData).not.toHaveProperty("summary");
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

  it("accepts a reports_to manager principal and stores it in data", async () => {
    mocks.getEntity.mockResolvedValue({
      id: "principal_manager",
      doco_id: "doco_acme",
      data: { neuron_type: "principal", name: "boss" },
    });

    const response = await action({
      request: principalRequest({
        name: "alice",
        reports_to: "principal_manager",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.getEntity).toHaveBeenCalledWith("principal", "principal_manager");
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "alice",
          reports_to: "principal_manager",
        }),
      }),
    );
    expect(mocks.reindexAndScheduleAttach).toHaveBeenCalledWith(
      expect.stringContaining("acme"),
      "doco_acme",
      expect.stringMatching(/^principal_/),
    );
  });

  it("rejects reports_to that doesn't look like a principal id", async () => {
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
      error: expect.stringContaining("reports_to must be a principal id"),
    });
  });

  it("rejects reports_to that points at a principal in a different Doco", async () => {
    mocks.getEntity.mockResolvedValue({
      id: "principal_stranger",
      doco_id: "doco_other",
      data: { neuron_type: "principal", name: "stranger" },
    });

    const response = await action({
      request: principalRequest({
        name: "alice",
        reports_to: "principal_stranger",
      }),
      params: { docoHandle: "acme" } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertEntity).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reports_to principal not found"),
    });
  });
});
