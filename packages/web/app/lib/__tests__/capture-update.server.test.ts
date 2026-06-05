import { getDocoById, getEntity, upsertEntity } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureGenericNode,
  renderOperationLines,
  updateDecision,
  updateEntity,
} from "../capture.server";

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
    idea: { table: "ideas", body: false, typeNamedColumn: "idea" },
    state: { table: "states", body: false, typeNamedColumn: "state" },
    action: { table: "actions", body: false, typeNamedColumn: "action" },
    reference: { table: "nodes", body: false, typeNamedColumn: "prose" },
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
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

describe("updateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDocoById).mockResolvedValue({
      id: DOCO_ID,
      handle: "test-doco",
    } as Awaited<ReturnType<typeof getDocoById>>);
  });

  it("does not change the node name when the route does not allow renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: STATE_ID,
      entity_type: "state",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: STATE_ID,
        doco_id: DOCO_ID,
        node_type: "state",
        state: "Original state name",
        kind: "intermediate",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "state",
      pluralDir: "states",
      id: STATE_ID,
      patch: {
        state: "Renamed state name",
        kind: "terminal",
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      // Pre-Step-B: `state` (the type-named prose column) was silently
      // ignored when the route's allowedFields whitelist didn't list
      // it. After Step B removed whitelists, the prose column edit
      // now lands alongside `kind`.
      changed: ["state", "kind"],
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        type_named_value: "Renamed state name",
        data: expect.objectContaining({
          state: "Renamed state name",
          kind: "terminal",
        }),
      }),
      expect.anything(),
    );
  });

  it("updates the node name when the route explicitly allows renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: IDEA_ID,
      entity_type: "idea",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: IDEA_ID,
        doco_id: DOCO_ID,
        node_type: "idea",
        idea: "Original idea name",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "idea",
      pluralDir: "ideas",
      id: IDEA_ID,
      patch: {
        idea: "Renamed idea name",
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      changed: ["idea"],
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        type_named_value: "Renamed idea name",
        data: expect.objectContaining({
          idea: "Renamed idea name",
        }),
      }),
      expect.anything(),
    );
  });

  it("rejects patching Decision sequence_to because BPMN flow is edge-only", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: DECISION_ID,
      entity_type: "decision",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: DECISION_ID,
        doco_id: DOCO_ID,
        node_type: "decision",
        decision: "Choose payment path",
        question: "Which payment path?",
        chosen: "Route to the selected path.",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

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
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("rejects patching a Decision's implemented_by relation", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: DECISION_ID,
      entity_type: "decision",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: DECISION_ID,
        doco_id: DOCO_ID,
        node_type: "decision",
        decision: "Choose payment path",
        question: "Which payment path?",
        chosen: "Route to the selected path.",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

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
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  const REFERENCE_ID = "reference_01TEST000000000000000001";

  it("flattens an attributes patch onto the node data (reference body_md update)", async () => {
    // The title/body split: on PR re-sync the import patch carries the new body
    // in `attributes.body_md`. updateEntity must merge those keys onto the data
    // bag as FLAT keys (so storage re-bags them into the attributes jsonb), not
    // store a nested `attributes` object.
    vi.mocked(getEntity).mockResolvedValue({
      id: REFERENCE_ID,
      entity_type: "reference",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: REFERENCE_ID,
        doco_id: DOCO_ID,
        node_type: "reference",
        reference: "Old title",
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
        body_md: "Old body.",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "reference",
      pluralDir: "references",
      id: REFERENCE_ID,
      patch: {
        reference: "New title",
        attributes: { body_md: "New body." },
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({ ok: true });
    const rec = vi.mocked(upsertEntity).mock.calls[0][0];
    // The title (type-named prose) and the new body both land as flat keys.
    expect(rec.type_named_value).toBe("New title");
    expect(rec.data).toMatchObject({ reference: "New title", body_md: "New body." });
    // No nested `attributes` object leaks into the data bag.
    expect(rec.data).not.toHaveProperty("attributes");
  });

  it("clears body_md when the attributes patch sets it to null (PR body emptied)", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: REFERENCE_ID,
      entity_type: "reference",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: REFERENCE_ID,
        doco_id: DOCO_ID,
        node_type: "reference",
        reference: "Title",
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
        body_md: "Body to be removed.",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "reference",
      pluralDir: "references",
      id: REFERENCE_ID,
      patch: {
        reference: "Title",
        attributes: { body_md: null },
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({ ok: true, changed: ["body_md"] });
    const rec = vi.mocked(upsertEntity).mock.calls[0][0];
    // body_md is gone from the data bag (storage drops null/absent keys).
    expect(rec.data).not.toHaveProperty("body_md");
  });

  it("is a no-op when title + body are unchanged (idempotent re-sync)", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: REFERENCE_ID,
      entity_type: "reference",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: REFERENCE_ID,
        doco_id: DOCO_ID,
        node_type: "reference",
        reference: "Stable title",
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
        body_md: "Stable body.",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "reference",
      pluralDir: "references",
      id: REFERENCE_ID,
      patch: {
        reference: "Stable title",
        lifecycle: "active",
        attributes: { body_md: "Stable body." },
      },
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({ error: "No fields changed." });
    expect(upsertEntity).not.toHaveBeenCalled();
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
        attributes: {
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
    expect(upsertEntity).not.toHaveBeenCalled();
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
        attributes: { question: "What lifecycle is stored?", chosen: "asserted" },
        lifecycle: "asserted",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ error: expect.stringContaining("Unknown lifecycle: asserted") });
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("rejects created_by_principal_id patches", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: IDEA_ID,
      entity_type: "idea",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "drafting",
      body_md: "",
      data: {
        id: IDEA_ID,
        doco_id: DOCO_ID,
        node_type: "idea",
        idea: "Original idea",
        lifecycle: "drafting",
        created_by: "user_alice",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

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
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("rejects patching an Action's implemented_by relation", async () => {
    const ACTION_ID = "action_01TEST00000000000000000001";
    vi.mocked(getEntity).mockResolvedValue({
      id: ACTION_ID,
      entity_type: "action",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: ACTION_ID,
        doco_id: DOCO_ID,
        node_type: "action",
        action: "Selects type of job",
        verb: "select",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

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
    expect(upsertEntity).not.toHaveBeenCalled();
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
