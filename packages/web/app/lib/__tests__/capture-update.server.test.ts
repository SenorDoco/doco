import { getDocoById, getEntity, upsertEntity } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDecision,
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
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(async (fn) => fn({})),
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

  it("does not change the neuron name when the route does not allow renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: STATE_ID,
      entity_type: "state",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "asserted",
      body_md: "",
      data: {
        id: STATE_ID,
        doco_id: DOCO_ID,
        neuron_type: "state",
        state: "Original state name",
        kind: "intermediate",
        lifecycle: "asserted",
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

  it("updates the neuron name when the route explicitly allows renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: IDEA_ID,
      entity_type: "idea",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "asserted",
      body_md: "",
      data: {
        id: IDEA_ID,
        doco_id: DOCO_ID,
        neuron_type: "idea",
        idea: "Original idea name",
        lifecycle: "asserted",
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

  it("patches active Decision sequence_to so BPMN flow edges can be authored after capture", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: DECISION_ID,
      entity_type: "decision",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "asserted",
      body_md: "",
      data: {
        id: DECISION_ID,
        doco_id: DOCO_ID,
        neuron_type: "decision",
        decision: "Choose payment path",
        question: "Which payment path?",
        chosen: "Route to the selected path.",
        lifecycle: "asserted",
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
      ok: true,
      changed: ["sequence_to"],
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sequence_to: [{ target: "action_01TEST000000000000000001", label: "Card" }],
        }),
      }),
      expect.anything(),
    );
  });

  it("replaces a frozen Decision's implemented_by — set after capture, editable past freeze", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: DECISION_ID,
      entity_type: "decision",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "asserted",
      body_md: "",
      data: {
        id: DECISION_ID,
        doco_id: DOCO_ID,
        neuron_type: "decision",
        decision: "Choose payment path",
        question: "Which payment path?",
        chosen: "Route to the selected path.",
        lifecycle: "asserted",
        implemented_by: ["reference_01TEST000000000000000001"],
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

    expect(result).toMatchObject({ ok: true, changed: ["implemented_by"] });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          implemented_by: ["reference_01TEST000000000000000003"],
        }),
      }),
      expect.anything(),
    );
  });

  it("stores Decision created_by from the user, not the decider Principal", async () => {
    const result = await captureDecision(
      "/tmp/doco",
      DOCO_ID,
      "test",
      "doco",
      {
        decision: "Use user provenance",
        question: "Who created this neuron?",
        chosen: "The authenticated user.",
        decided_by_principal_id: "principal_decider",
        created_by_principal_id: "principal_legacy_creator",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "decision",
        created_by: "user_alice",
        data: expect.objectContaining({
          decided_by: "principal_decider",
          created_by: "user_alice",
        }),
      }),
      expect.anything(),
    );
    expect(vi.mocked(upsertEntity).mock.calls.at(-1)?.[0].data).not.toMatchObject({
      created_by: "principal_legacy_creator",
    });
  });

  it('rejects the retired lifecycle vocabulary ("active"/"proposed") on capture', async () => {
    const result = await captureDecision(
      "/tmp/doco",
      DOCO_ID,
      "test",
      "doco",
      {
        decision: "Adopt the new vocabulary",
        question: "What lifecycle is stored?",
        chosen: "asserted",
        lifecycle: "active",
        decided_by_principal_id: "principal_decider",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ error: expect.stringContaining("Unknown lifecycle: active") });
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("ignores legacy created_by_principal_id patches", async () => {
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
        neuron_type: "idea",
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

    expect(result).toMatchObject({ error: "No fields changed." });
    expect(upsertEntity).not.toHaveBeenCalled();
  });

  it("links an accepted Action to code-artifact References via implemented_by — BPMN code↔step linkage", async () => {
    // The BPMN code↔step probe case: an Action whose ID is referenced
    // from code comments cannot be superseded without breaking those
    // URLs. implemented_by must be fully patchable on a frozen Action.
    const ACTION_ID = "action_01TEST00000000000000000001";
    vi.mocked(getEntity).mockResolvedValue({
      id: ACTION_ID,
      entity_type: "action",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "asserted",
      body_md: "",
      data: {
        id: ACTION_ID,
        doco_id: DOCO_ID,
        neuron_type: "action",
        action: "Selects type of job",
        verb: "select",
        lifecycle: "asserted",
        actor_id: "principal_clerk",
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
      ok: true,
      changed: ["implemented_by"],
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: "action",
        data: expect.objectContaining({
          implemented_by: [
            "reference_01TEST000000000000000010",
            "reference_01TEST000000000000000011",
          ],
        }),
      }),
      expect.anything(),
    );
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
