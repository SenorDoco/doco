import { getDocoById, upsertEntity } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureGenericNode } from "../capture.server";

// Node-shape slim-down (raw-schema phase, contract step): the API exposes the
// row schema directly. A single generic capture path writes prose→prose,
// kind→kind, attributes→attributes — no per-type translation. These pin the
// generic writer's behaviour against a mocked storage layer.

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
    action: { table: "actions", body: false, typeNamedColumn: "action" },
    eval: { table: "evals", body: false, typeNamedColumn: "eval" },
    idea: { table: "ideas", body: false, typeNamedColumn: "idea" },
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  recordEntityVersion: vi.fn(async () => undefined),
  withClient: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
  withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("../audit-log.server", () => ({ appendAuditEvent: vi.fn() }));
vi.mock("../authoring-runner.server", () => ({
  runAuthoringPolicies: vi.fn(async () => ({
    evaluated: 0,
    passed: 0,
    blocking: null,
    violations: [],
    warnings: [],
  })),
}));
vi.mock("../redeem.server", () => ({
  reindex: vi.fn(async () => undefined),
  reindexEmbeddingsOnly: vi.fn(async () => undefined),
}));

const DOCO_ID = "doco_01TEST00000000000000000001";

function capture(entityType: string, draft: Record<string, unknown>) {
  return captureGenericNode(
    "/tmp/doco",
    DOCO_ID,
    "test",
    "doco",
    entityType,
    draft,
    "https://doco.test",
  );
}

describe("captureGenericNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDocoById).mockResolvedValue({
      id: DOCO_ID,
      handle: "test-doco",
      default_node_lifecycle: null,
    } as Awaited<ReturnType<typeof getDocoById>>);
  });

  it("writes prose → the type-named column and attributes → the bag", async () => {
    const res = await capture("decision", {
      prose: "Adopt the raw schema",
      attributes: { question: "What shape does the API expose?", chosen: "The row schema." },
    });
    expect(res).toMatchObject({ ok: true, id: expect.stringMatching(/^decision_/) });
    expect(upsertEntity).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(upsertEntity).mock.calls[0][0];
    // prose flows to the type-named value (→ prose column in storage).
    expect(rec.type_named_value).toBe("Adopt the raw schema");
    // attributes are spread flat onto the data bag (storage re-bags them).
    expect(rec.data).toMatchObject({
      node_type: "decision",
      decision: "Adopt the raw schema",
      question: "What shape does the API expose?",
      chosen: "The row schema.",
    });
  });

  it("promotes a top-level `kind` for eval/state nodes", async () => {
    await capture("eval", {
      prose: "Slug normalization returns the canonical handle",
      kind: "unit",
      attributes: { criterion: { kind: "exact" } },
    });
    const rec = vi.mocked(upsertEntity).mock.calls[0][0];
    expect(rec.data).toMatchObject({ node_type: "eval", kind: "unit" });
  });

  it("accepts the legacy type-named field as an alias for prose", async () => {
    await capture("action", { action: "Deploy the build", attributes: { verb: "deploy" } });
    const rec = vi.mocked(upsertEntity).mock.calls[0][0];
    expect(rec.type_named_value).toBe("Deploy the build");
    expect(rec.data).toMatchObject({ verb: "deploy" });
  });

  it("does NOT enforce per-type required fields (left to authoring policies)", async () => {
    // An Action with no verb used to 400; the generic path writes it through.
    const res = await capture("action", { prose: "Bare action" });
    expect(res).toMatchObject({ ok: true });
    expect(upsertEntity).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing prose body up front", async () => {
    const res = await capture("intent", { attributes: {} });
    expect(res).toMatchObject({ error: expect.stringContaining("prose is required") });
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("rejects first-class-edge keys in the body", async () => {
    const res = await capture("decision", {
      prose: "x",
      attributes: { implemented_by: ["reference_1"] },
    });
    expect(res).toMatchObject({
      error: expect.stringContaining("implemented_by is not a node JSON field"),
    });
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("rejects an unknown lifecycle", async () => {
    const res = await capture("decision", { prose: "x", lifecycle: "asserted" });
    expect(res).toMatchObject({ error: expect.stringContaining("Unknown lifecycle: asserted") });
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("honours per-type default lifecycle (idea → drafting)", async () => {
    await capture("idea", { prose: "A possibility", created_by_user_id: "user_alice" });
    const rec = vi.mocked(upsertEntity).mock.calls[0][0];
    expect(rec.data).toMatchObject({ lifecycle: "drafting" });
  });
});
