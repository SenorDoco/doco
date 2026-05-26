import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendAuditEvent: vi.fn(),
  getDocoById: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listEntitiesByDoco: vi.fn(),
  listPrincipals: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  reindex: vi.fn(),
  reindexEmbeddingsOnly: vi.fn(),
  runAuthoringPolicies: vi.fn(),
  upsertEntity: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank = { reader: 1, author: 2, approver: 3, owner: 4 } as const;
  return {
    ALL_ENTITY_TABLES: {
      eval: { table: "evals", typeNamedColumn: "eval" },
    },
    getDocoById: mocks.getDocoById,
    listEntitiesByDoco: mocks.listEntitiesByDoco,
    listPrincipals: mocks.listPrincipals,
    roleAtLeast: (have: keyof typeof rank | null, want: keyof typeof rank) =>
      Boolean(have && rank[have] >= rank[want]),
    upsertEntity: mocks.upsertEntity,
    withClient: mocks.withClient,
    withTransaction: mocks.withTransaction,
  };
});

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
}));

vi.mock("~/lib/authoring-runner.server", () => ({
  runAuthoringPolicies: mocks.runAuthoringPolicies,
}));

vi.mock("~/lib/audit-log.server", () => ({
  appendAuditEvent: mocks.appendAuditEvent,
}));

vi.mock("~/lib/redeem.server", () => ({
  reindex: mocks.reindex,
  reindexEmbeddingsOnly: mocks.reindexEmbeddingsOnly,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import { action } from "../$docoHandle.api.$type[.]json";

function evalRequest(body: Record<string, unknown>): Request {
  return new Request("https://doco.test/acme/api/evals.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("generic eval capture API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocoById.mockResolvedValue({ handle: "acme" });
    mocks.getDocoLevelRole.mockResolvedValue("author");
    mocks.listPrincipals.mockResolvedValue([]);
    mocks.loadDocoRouteForRead.mockResolvedValue({
      dir: "/tmp/docos/acme",
      docoSlug: "acme",
      me: { id: "collaborator_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "organization_acme", docoId: "doco_acme" },
      ownerSlug: "acme",
    });
    mocks.reindex.mockResolvedValue(undefined);
    mocks.reindexEmbeddingsOnly.mockResolvedValue(undefined);
    mocks.runAuthoringPolicies.mockResolvedValue({ blocking: null, warnings: [] });
    mocks.upsertEntity.mockResolvedValue(undefined);
    mocks.withClient.mockImplementation((fn) => fn({ query: vi.fn().mockResolvedValue({}) }));
    mocks.withTransaction.mockImplementation((fn) => fn({}));
  });

  it("uses the authenticated collaborator as Eval creator when the doco has no Principal neurons", async () => {
    const response = await action({
      request: evalRequest({
        eval: "unit exact slug normalization returns canonical handle",
        kind: "unit",
        criterion: { kind: "exact" },
        expected: "codex-prod-test",
      }),
      params: { docoHandle: "acme", type: "evals" } as never,
    });

    expect(response.status).toBe(201);
    expect(mocks.upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "eval",
        created_by: "collaborator_author",
        data: expect.objectContaining({
          created_by: "collaborator_author",
          eval: "unit exact slug normalization returns canonical handle",
          kind: "unit",
        }),
      }),
      expect.anything(),
    );
    expect(mocks.upsertEntity.mock.calls[0][0].data).not.toHaveProperty(
      "created_by_collaborator_id",
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: expect.stringMatching(/^eval_/),
      footer_lines: [expect.stringContaining("Eval added")],
    });
  });
});
