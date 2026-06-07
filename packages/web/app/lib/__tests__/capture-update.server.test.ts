import { getDocoById, getEntity, nodeRowFromFields, upsertNode } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureGenericNode,
  renderOperationLines,
  updateDecision,
  updateEntity,
} from "../capture.server";

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "nodes", body: false, typeNamedColumn: "prose" },
    idea: { table: "nodes", body: false, typeNamedColumn: "prose" },
    state: { table: "nodes", body: false, typeNamedColumn: "prose" },
    action: { table: "nodes", body: false, typeNamedColumn: "prose" },
    reference: { table: "nodes", body: false, typeNamedColumn: "prose" },
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertNode: vi.fn(),
  upsertPolicy: vi.fn(),
  // Capture the flat field bag handed to the write boundary, unchanged.
  nodeRowFromFields: vi.fn((_type: string, fields: Record<string, unknown>) => fields),
  recordEntityVersion: vi.fn(async () => undefined),
  withClient: vi.fn(),
  withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
  createChangeset: vi.fn(async () => 1),
  createEdge: vi.fn(async () => ({})),
  retireEdge: vi.fn(async () => ({})),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../audit-log.server", () => ({
  appendAuditEvent: vi.fn(),
}));

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
const DECISION_ID = "decision_01TEST000000000000000001";
const STATE_ID = "state_01TEST0000000000000000001";
const IDEA_ID = "idea_01TEST00000000000000000001";

// Build a `NodeRow` (the honest read shape `getEntity` returns) from a flat
// field bag; anything that isn't a real column lands in `extra`.
function nodeRow(bag: Record<string, unknown>): Awaited<ReturnType<typeof getEntity>> {
  const cols = new Set([
    "id",
    "doco_id",
    "node_type",
    "lifecycle",
    "prose",
    "kind",
    "locator",
    "proposer_id",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) if (!cols.has(k)) extra[k] = v;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: String(bag.id),
    doco_id: String(bag.doco_id),
    node_type: String(bag.node_type),
    lifecycle: s(bag.lifecycle),
    prose: typeof bag.prose === "string" ? bag.prose : "",
    extra,
    kind: s(bag.kind),
    locator: s(bag.locator),
    proposer_id: s(bag.proposer_id),
    created_at: s(bag.created_at),
    created_by: s(bag.created_by),
    updated_at: s(bag.updated_at),
    updated_by: s(bag.updated_by),
  } as Awaited<ReturnType<typeof getEntity>>;
}

describe("updateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDocoById).mockResolvedValue({
      id: DOCO_ID,
      handle: "test-doco",
    } as Awaited<ReturnType<typeof getDocoById>>);
  });

  it("does not change the node name when the route does not allow renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: STATE_ID,
        doco_id: DOCO_ID,
        node_type: "state",
        prose: "Original state name",
        kind: "intermediate",
        lifecycle: "active",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "state",
      pluralDir: "states",
      id: STATE_ID,
      patch: {
        prose: "Renamed state name",
        kind: "terminal",
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      // A node's text has exactly one name: `prose`.
      changed: ["prose", "kind"],
    });
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ prose: "Renamed state name", kind: "terminal" }),
      expect.anything(),
    );
  });

  it("updates the node name when the route explicitly allows renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: IDEA_ID,
        doco_id: DOCO_ID,
        node_type: "idea",
        prose: "Original idea name",
        lifecycle: "active",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "idea",
      pluralDir: "ideas",
      id: IDEA_ID,
      patch: {
        prose: "Renamed idea name",
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      changed: ["prose"],
    });
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ prose: "Renamed idea name" }),
      expect.anything(),
    );
  });

  it("rejects patching Decision sequence_to because BPMN flow is edge-only", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: DECISION_ID,
        doco_id: DOCO_ID,
        node_type: "decision",
        prose: "Choose payment path",
        question: "Which payment path?",
        chosen: "Route to the selected path.",
        lifecycle: "active",
      }),
    );

    const result = await updateDecision(
      "/tmp/doco",
      DOCO_ID,
      "test",
      "doco",
      DECISION_ID,
      {
        sequence_to: [{ target: "action_01TEST000000000000000001", label: "Card" }],
      },
      "https://doco.test",
      null,
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("sequence_to is not a node JSON field"),
    });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("rejects patching a Decision's implemented_by relation", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: DECISION_ID,
        doco_id: DOCO_ID,
        node_type: "decision",
        prose: "Choose payment path",
        question: "Which payment path?",
        chosen: "Route to the selected path.",
        lifecycle: "active",
      }),
    );

    const result = await updateDecision(
      "/tmp/doco",
      DOCO_ID,
      "test",
      "doco",
      DECISION_ID,
      {
        implemented_by: ["reference_01TEST000000000000000003"],
      },
      "https://doco.test",
      null,
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("implemented_by is not a node JSON field"),
    });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  const REFERENCE_ID = "reference_01TEST000000000000000001";

  it("flattens an extra patch onto the node data (reference content_hash update)", async () => {
    // On PR re-sync the import patch carries reference scalars (ref_type /
    // locator / content_hash) in `extra`. updateEntity must merge those
    // keys onto the data bag as FLAT keys (so storage re-bags them into the
    // extra jsonb), not store a nested `extra` object.
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: REFERENCE_ID,
        doco_id: DOCO_ID,
        node_type: "reference",
        prose: "Old title",
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
        content_hash: "old_hash",
        lifecycle: "active",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "reference",
      pluralDir: "references",
      id: REFERENCE_ID,
      patch: {
        prose: "New title",
        extra: { content_hash: "new_hash" },
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({ ok: true });
    const fields = vi.mocked(nodeRowFromFields).mock.calls[0][1];
    // The title (`prose`) and the new attribute both land as flat keys.
    expect(fields.prose).toBe("New title");
    expect(fields).toMatchObject({ prose: "New title", content_hash: "new_hash" });
    // No nested `extra` object leaks into the field bag.
    expect(fields).not.toHaveProperty("extra");
  });

  it("clears a flat attribute when the extra patch sets it to null", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: REFERENCE_ID,
        doco_id: DOCO_ID,
        node_type: "reference",
        prose: "Title",
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
        content_hash: "hash_to_remove",
        lifecycle: "active",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "reference",
      pluralDir: "references",
      id: REFERENCE_ID,
      patch: {
        prose: "Title",
        extra: { content_hash: null },
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({ ok: true, changed: ["content_hash"] });
    const fields = vi.mocked(nodeRowFromFields).mock.calls[0][1];
    // content_hash is gone from the field bag (the boundary drops null/absent keys).
    expect(fields).not.toHaveProperty("content_hash");
  });

  it("is a no-op when title + extra are unchanged (idempotent re-sync)", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: REFERENCE_ID,
        doco_id: DOCO_ID,
        node_type: "reference",
        prose: "Stable title",
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
        content_hash: "stable_hash",
        lifecycle: "active",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "reference",
      pluralDir: "references",
      id: REFERENCE_ID,
      patch: {
        prose: "Stable title",
        lifecycle: "active",
        extra: { content_hash: "stable_hash" },
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({ error: "No fields changed." });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("rejects created_by_principal_id on Decision capture because authorship is edge-only", async () => {
    const result = await captureGenericNode(
      "/tmp/doco",
      DOCO_ID,
      "test",
      "doco",
      "decision",
      {
        prose: "Use user provenance",
        extra: {
          question: "Who created this node?",
          chosen: "The authenticated user.",
          created_by_principal_id: "principal_creator",
        },
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("created_by_principal_id is not a node JSON field"),
    });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('rejects the retired lifecycle vocabulary ("asserted"/"proposed") on capture', async () => {
    const result = await captureGenericNode(
      "/tmp/doco",
      DOCO_ID,
      "test",
      "doco",
      "decision",
      {
        prose: "Adopt the new vocabulary",
        extra: { question: "What lifecycle is stored?", chosen: "asserted" },
        lifecycle: "asserted",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ error: expect.stringContaining("Unknown lifecycle: asserted") });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("rejects created_by_principal_id patches", async () => {
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: IDEA_ID,
        doco_id: DOCO_ID,
        node_type: "idea",
        prose: "Original idea",
        lifecycle: "drafting",
        created_by: "user_alice",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "idea",
      pluralDir: "ideas",
      id: IDEA_ID,
      patch: {
        created_by_principal_id: "principal_eve",
      },
      docoHost: "https://doco.test",
      actorId: "user_alice",
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("created_by_principal_id is not a node JSON field"),
    });
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it("rejects patching an Action's implemented_by relation", async () => {
    const ACTION_ID = "action_01TEST00000000000000000001";
    vi.mocked(getEntity).mockResolvedValue(
      nodeRow({
        id: ACTION_ID,
        doco_id: DOCO_ID,
        node_type: "action",
        prose: "Selects type of job",
        verb: "select",
        lifecycle: "active",
      }),
    );

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "action",
      pluralDir: "actions",
      id: ACTION_ID,
      patch: {
        implemented_by: [
          "reference_01TEST000000000000000010",
          "reference_01TEST000000000000000011",
        ],
      },
      docoHost: "https://doco.test",
      actorId: "user_alice",
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("implemented_by is not a node JSON field"),
    });
    expect(upsertNode).not.toHaveBeenCalled();
  });
});

describe("renderOperationLines", () => {
  it("adds the authoring-policy pass summary to the final operation line", async () => {
    const lines = await renderOperationLines({
      ownerSlug: "acme",
      docoSlug: "ops",
      handle: "acme-ops",
      entityType: "decision",
      id: "decision_01TEST0000000000000000001",
      label: "Use checked footers",
      docoHost: "https://doco.test",
      ops: [{ kind: "added", summary: "Use checked footers" }],
      duration_ms: 1234,
      authoringPoliciesPassed: 3,
    });

    expect(lines).toEqual([
      "[🔮 Doco] ✍️ Decision added: [Use checked footers](https://doco.test/acme-ops/decision/decision_01TEST0000000000000000001) (✅ 3 authoring policies passed in 1.2s)",
    ]);
  });

  it("uses singular grammar for one passed authoring policy", async () => {
    const lines = await renderOperationLines({
      ownerSlug: "acme",
      docoSlug: "ops",
      handle: "acme-ops",
      entityType: "decision",
      id: "decision_01TEST0000000000000000001",
      label: "Use checked footers",
      ops: [{ kind: "added", summary: "Use checked footers" }],
      duration_ms: 1000,
      authoringPoliciesPassed: 1,
    });

    expect(lines.at(0)).toBe(
      "[🔮 Doco] ✍️ Decision added: Use checked footers (✅ 1 authoring policy passed in 1.0s)",
    );
  });
});
