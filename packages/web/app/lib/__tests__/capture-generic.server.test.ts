import { getDocoById, nodeRowFromFields, upsertNode } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureGenericNode } from "../capture.server";

// Node-shape slim-down (raw-schema phase, contract step): the API exposes the
// row schema directly. A single generic capture path writes prose→prose,
// kind→kind, extra→extra — no per-type translation. These pin the
// generic writer's behaviour against a mocked storage layer. The captured field
// bag is asserted at the one write boundary (`nodeRowFromFields`'s input); the
// bag→NodeRow split itself is pinned in node-write-boundary.test.ts.

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
    action: { table: "actions", body: false, typeNamedColumn: "action" },
    eval: { table: "evals", body: false, typeNamedColumn: "eval" },
    idea: { table: "ideas", body: false, typeNamedColumn: "idea" },
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertNode: vi.fn(),
  upsertPolicy: vi.fn(),
  // Capture the flat field bag handed to the write boundary, unchanged.
  nodeRowFromFields: vi.fn((_type: string, fields: Record<string, unknown>) => fields),
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

/** The flat field bag handed to the write boundary on the most recent capture. */
function capturedFields(): Record<string, unknown> {
  const call = vi.mocked(nodeRowFromFields).mock.calls.at(0);
  if (!call) throw new Error("nodeRowFromFields was not called");
  return call[1];
}

function capture(nodeType: string, draft: Record<string, unknown>) {
  return captureGenericNode(
    "/tmp/doco",
    DOCO_ID,
    "test",
    "doco",
    nodeType,
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

  it("writes prose → the type-named column and extra → the bag", async () => {
    const res = await capture("decision", {
      prose: "Adopt the raw schema",
      extra: { question: "What shape does the API expose?", chosen: "The row schema." },
    });
    expect(res).toMatchObject({ ok: true, id: expect.stringMatching(/^decision_/) });
    expect(upsertNode).toHaveBeenCalledTimes(1);
    const fields = capturedFields();
    // The text flows under the single canonical key `prose` (→ prose column).
    expect(fields.prose).toBe("Adopt the raw schema");
    // extra are spread flat onto the field bag (the boundary re-bags them).
    expect(fields).toMatchObject({
      node_type: "decision",
      prose: "Adopt the raw schema",
      question: "What shape does the API expose?",
      chosen: "The row schema.",
    });
  });

  it("promotes a top-level `kind` for eval/state nodes", async () => {
    await capture("eval", {
      prose: "Slug normalization returns the canonical handle",
      kind: "unit",
      extra: { criterion: { kind: "exact" } },
    });
    expect(capturedFields()).toMatchObject({ node_type: "eval", kind: "unit" });
  });

  it("requires `prose` — the type-named field is no longer an alias", async () => {
    // A node's text has exactly one name. Sending the old type-named key
    // (`action`) without `prose` is rejected, not silently accepted.
    const res = await capture("action", { action: "Deploy the build", extra: { verb: "deploy" } });
    expect(res).toMatchObject({ error: expect.stringContaining("prose is required") });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("does NOT enforce per-type required fields (left to authoring policies)", async () => {
    // An Action with no verb used to 400; the generic path writes it through.
    const res = await capture("action", { prose: "Bare action" });
    expect(res).toMatchObject({ ok: true });
    expect(upsertNode).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing prose body up front", async () => {
    const res = await capture("intent", { extra: {} });
    expect(res).toMatchObject({ error: expect.stringContaining("prose is required") });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("rejects first-class-edge keys in the body", async () => {
    const res = await capture("decision", {
      prose: "x",
      extra: { implemented_by: ["reference_1"] },
    });
    expect(res).toMatchObject({
      error: expect.stringContaining("implemented_by is not a node JSON field"),
    });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("rejects an unknown lifecycle", async () => {
    const res = await capture("decision", { prose: "x", lifecycle: "asserted" });
    expect(res).toMatchObject({ error: expect.stringContaining("Unknown lifecycle: asserted") });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("honours per-type default lifecycle (idea → drafting)", async () => {
    await capture("idea", { prose: "A possibility", created_by_user_id: "user_alice" });
    expect(capturedFields()).toMatchObject({ lifecycle: "drafting" });
  });
});
