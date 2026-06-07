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
  upsertNode: vi.fn(),
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
    nodeRowFromFields: (_type: string, fields: Record<string, unknown>) => fields,
    upsertNode: mocks.upsertNode,
    upsertPolicy: vi.fn(),
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
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    mocks.listPrincipals.mockResolvedValue([]);
    mocks.loadDocoRouteForRead.mockResolvedValue({
      dir: "/tmp/docos/acme",
      docoSlug: "acme",
      me: { id: "user_author", username: "alice", type: "person", isHuman: true },
      meta: { ownerId: "workspace_acme", docoId: "doco_acme" },
      ownerSlug: "acme",
    });
    mocks.reindex.mockResolvedValue(undefined);
    mocks.reindexEmbeddingsOnly.mockResolvedValue(undefined);
    mocks.runAuthoringPolicies.mockResolvedValue({ blocking: null, warnings: [] });
    mocks.upsertNode.mockResolvedValue(undefined);
    mocks.withClient.mockImplementation((fn) => fn({ query: vi.fn().mockResolvedValue({}) }));
    mocks.withTransaction.mockImplementation((fn) => fn({}));
  });

  it("rejects principal provenance fields on Eval capture", async () => {
    const response = await action({
      request: evalRequest({
        eval: "unit exact slug normalization returns canonical handle",
        kind: "unit",
        criterion: { kind: "exact" },
        expected: "codex-prod-test",
        created_by: "principal_spoofed",
        created_by_principal_id: "principal_spoofed",
        created_by_user_id: "user_spoofed",
      }),
      params: { docoHandle: "acme", type: "evals" } as never,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsertNode).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("created_by_principal_id is not a node JSON field"),
    });
  });
});
