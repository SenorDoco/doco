import { upsertEntity, withClient } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAuthoringPrimitives } from "../authoring-runner.server";
import {
  type NeuronAuthoringPrimitiveDraft,
  captureNeuronAuthoringPrimitive,
} from "../capture.server";
import { judgeProbabilisticPredicate } from "../llm-judge.server";

// Required test DB lifecycle hooks (beforeAll/beforeEach/afterAll).
import "./db-isolation";

vi.mock("../llm-judge.server", () => ({
  judgeProbabilisticPredicate: vi.fn(),
}));
const mockedJudge = vi.mocked(judgeProbabilisticPredicate);

beforeEach(() => {
  mockedJudge.mockReset();
});

const DOCO_ID = "doco_01TEST00000000000000000001";
const ORG_ID = "organization_01TESTORG000000000000001";
const PRINCIPAL_ALICE = "principal_01TESTALICE0000000000001";
const PRIMITIVE_ID_PRINCIPAL = "neuron_authoring_primitive_01TESTPRINCIPAL000000001";
const PRIMITIVE_ID_FIELD = "neuron_authoring_primitive_01TESTFIELD000000000001";
const PRIMITIVE_ID_PROBABILISTIC = "neuron_authoring_primitive_01TESTPROB0000000000001";

interface SeedOpts {
  withPrincipalRule?: boolean;
  withRequiredFieldRule?: boolean;
  withProbabilisticRule?: boolean;
  firesOnActive?: boolean;
}

async function seed(opts: SeedOpts = {}): Promise<void> {
  await withClient(async (c) => {
    // Insert an organization — required for the FK on docos.org_id.
    await c.query(
      `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
         VALUES ($1, 'test-org', 'Test Org', '{}'::jsonb, now(), now())`,
      [ORG_ID],
    );

    // Insert a doco — required for the FK on neuron_authoring_primitives.
    await c.query(
      `INSERT INTO docos (id, handle, name, owner_id, org_id, data, created_at, updated_at)
         VALUES ($1, 'smoke-test', 'Smoke Test', $2, $2, '{}'::jsonb, now(), now())`,
      [DOCO_ID, ORG_ID],
    );

    // Insert a Principal (Alice) scoped to the test Doco.
    await c.query(
      `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
         VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
      [PRINCIPAL_ALICE, DOCO_ID],
    );

    if (opts.withPrincipalRule) {
      const yaml = JSON.stringify({
        id: PRIMITIVE_ID_PRINCIPAL,
        doco_id: DOCO_ID,
        neuron_type: "neuron_authoring_primitive",
        primitive_kind: "neuron_authoring",
        summary: "Action.actor_id resolves to a Principal",
        evaluation_kind: "deterministic",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_neuron_type: ["action"],
        },
        on_violation: "block",
        ...(opts.firesOnActive ? { fires_when_neuron_lifecycle: ["active"] } : {}),
      });
      await c.query(
        `INSERT INTO neuron_authoring_primitives
           (id, doco_id, summary, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'active', now(), now())`,
        [PRIMITIVE_ID_PRINCIPAL, DOCO_ID, "Action.actor_id resolves to a Principal", yaml],
      );
    }

    if (opts.withRequiredFieldRule) {
      const yaml = JSON.stringify({
        id: PRIMITIVE_ID_FIELD,
        doco_id: DOCO_ID,
        neuron_type: "neuron_authoring_primitive",
        primitive_kind: "neuron_authoring",
        summary: "Action.actor_id is set",
        evaluation_kind: "deterministic",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_neuron_type: ["action"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO neuron_authoring_primitives
           (id, doco_id, summary, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'active', now(), now())`,
        [PRIMITIVE_ID_FIELD, DOCO_ID, "Action.actor_id is set", yaml],
      );
    }

    if (opts.withProbabilisticRule) {
      const yaml = JSON.stringify({
        id: PRIMITIVE_ID_PROBABILISTIC,
        doco_id: DOCO_ID,
        neuron_type: "neuron_authoring_primitive",
        primitive_kind: "neuron_authoring",
        summary: "Action summary is atomic",
        evaluation_kind: "probabilistic",
        predicate: {
          kind: "probabilistic",
          spec: "The Action's summary reads as an atomic business activity, not a vague umbrella phase.",
          when_neuron_type: ["action"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO neuron_authoring_primitives
           (id, doco_id, summary, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'active', now(), now())`,
        [PRIMITIVE_ID_PROBABILISTIC, DOCO_ID, "Action summary is atomic", yaml],
      );
    }
  });
}

describe("authoring runner — integration", () => {
  it("blocks an Action whose actor_id does not resolve to a Principal", async () => {
    await seed({ withPrincipalRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTBAD000000000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        actor_id: "principal_01GHOST000000000000000001",
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.predicate_kind).toBe("requires_field_resolves_to_principal");
    expect(result.blocking?.primitive_id).toBe(PRIMITIVE_ID_PRINCIPAL);
    expect(result.blocking?.reason).toMatch(/principal_01GHOST/);
    expect(result.blocking?.reason).toMatch(/does not resolve/);
  });

  it("passes an Action whose actor_id resolves to a known Principal", async () => {
    await seed({ withPrincipalRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTGOOD00000000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        actor_id: PRINCIPAL_ALICE,
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("blocks an Action with no actor_id at all (requires_field)", async () => {
    await seed({ withRequiredFieldRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTNOACTOR00000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        // actor_id intentionally omitted.
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.predicate_kind).toBe("requires_field");
    expect(result.blocking?.primitive_id).toBe(PRIMITIVE_ID_FIELD);
  });

  it("skips a primitive whose fires_when_neuron_lifecycle excludes the candidate", async () => {
    await seed({ withPrincipalRule: true, firesOnActive: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTDRAFTED00000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        actor_id: "principal_01GHOST000000000000000001",
        lifecycle: "drafting",
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it("returns nothing when the doco has no active primitives", async () => {
    await seed({}); // no primitives
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTNOPRIMS00000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        actor_id: "principal_01GHOST000000000000000001",
      },
    });

    expect(result.violations).toEqual([]);
    expect(result.blocking).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("blocks an Action when the LLM judge rejects a probabilistic predicate", async () => {
    mockedJudge.mockResolvedValue({
      ok: false,
      reason: "summary 'handle order' is a vague umbrella phase",
    });
    await seed({ withProbabilisticRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTVAGUE000000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "handle order",
        verb: "handle",
      },
    });

    expect(mockedJudge).toHaveBeenCalledTimes(1);
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.predicate_kind).toBe("probabilistic");
    expect(result.blocking?.primitive_id).toBe(PRIMITIVE_ID_PROBABILISTIC);
    expect(result.blocking?.reason).toMatch(/umbrella phase/);
  });

  it("passes when the LLM judge approves a probabilistic predicate", async () => {
    mockedJudge.mockResolvedValue({ ok: true });
    await seed({ withProbabilisticRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTATOMIC00000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "invoice mailed to customer",
        verb: "mail",
      },
    });

    expect(mockedJudge).toHaveBeenCalledTimes(1);
    expect(result.violations).toEqual([]);
    expect(result.blocking).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("demotes block to warn when the judge is unavailable (returns null)", async () => {
    mockedJudge.mockResolvedValue(null);
    await seed({ withProbabilisticRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTJUDGEDOWN000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "handle order",
        verb: "handle",
      },
    });

    expect(mockedJudge).toHaveBeenCalledTimes(1);
    expect(result.blocking).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.predicate_kind).toBe("probabilistic");
    expect(result.warnings[0]?.on_violation).toBe("warn");
  });

  it("honors pre-rename `when_node_type` on persisted primitives", async () => {
    // Regression test for a bug seen in production on doco-bpms: a primitive
    // seeded before the vocab sweep (nodes → neurons) persisted its filter
    // as `when_node_type`. The engine reads the post-rename `when_neuron_type`,
    // so without normalization the filter was silently dropped and the rule
    // fired against every candidate. loadPrimitives now normalizes legacy
    // keys at read time — the rule below targets eval and must NOT fire on
    // an action candidate.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'compat-org', 'Compat Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, name, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'compat-test', 'Compat Test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
      const legacyYaml = JSON.stringify({
        id: "neuron_authoring_primitive_01TESTLEGACY00000000000001",
        summary: "Eval needs target_ref",
        predicate: {
          kind: "requires_field",
          fields: ["target_ref"],
          // Pre-rename key. Engine reads `when_neuron_type` (post-rename);
          // normalizePredicateKeys translates this so the filter applies.
          when_node_type: ["eval"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO neuron_authoring_primitives
           (id, doco_id, summary, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'active', now(), now())`,
        [
          "neuron_authoring_primitive_01TESTLEGACY00000000000001",
          DOCO_ID,
          "Eval needs target_ref",
          legacyYaml,
        ],
      );
    });

    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTLEGACYACTION0000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        actor_id: PRINCIPAL_ALICE,
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it("skips enforcement entirely when the candidate is transitioning to retired", async () => {
    // Reported in chat: a probabilistic primitive (no fires_when_neuron_lifecycle
    // filter) blocked a State's retirement because the current content didn't
    // satisfy a quality rule. Retiring is a winding-down operation — the runner
    // should short-circuit and let the lifecycle transition through.
    await seed({ withPrincipalRule: true, withRequiredFieldRule: true });
    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTRETIRE00000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        summary: "send invoice",
        verb: "send",
        // Both rules above would fire on this candidate at active —
        // requires_field on missing actor_id, requires_field_resolves_to_principal
        // would also fail. But the lifecycle is retired, so nothing fires.
        lifecycle: "retired",
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("loads primitives whose lifecycle column is NULL (treated as active)", async () => {
    // Defends fix #1: loadPrimitives used WHERE lifecycle = 'active' (strict)
    // while the rest of the codebase uses COALESCE(lifecycle, 'active') =
    // 'active'. A primitive seeded by a migration / restored from backup
    // with a NULL lifecycle column was silently invisible to the enforcer.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'null-life-org', 'Null-Life Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, name, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'null-life', 'Null Life', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
      const yaml = JSON.stringify({
        id: PRIMITIVE_ID_FIELD,
        summary: "Action.actor_id is set",
        predicate: { kind: "requires_field", fields: ["actor_id"], when_neuron_type: ["action"] },
        on_violation: "block",
      });
      // Explicit NULL on the lifecycle column — should still load because
      // the loader COALESCEs NULL → 'active'.
      await c.query(
        `INSERT INTO neuron_authoring_primitives
           (id, doco_id, summary, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NULL, now(), now())`,
        [PRIMITIVE_ID_FIELD, DOCO_ID, "Action.actor_id is set", yaml],
      );
    });

    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTNULL00000000000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        // actor_id missing → should trip the primitive
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.primitive_id).toBe(PRIMITIVE_ID_FIELD);
  });

  it("warns and drops a primitive whose persisted predicate is malformed", async () => {
    // Defends fix #2: a primitive row whose `data.predicate` is not a JSON
    // object was silently skipped with no log. Now we console.warn so the
    // operator can spot it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seed({ withRequiredFieldRule: true });
      const malformedId = "neuron_authoring_primitive_01TESTBORKED00000000000001";
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO neuron_authoring_primitives
             (id, doco_id, summary, data, lifecycle, created_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, 'active', now(), now())`,
          [
            malformedId,
            DOCO_ID,
            "Borked",
            JSON.stringify({ summary: "Borked", predicate: "not-an-object" }),
          ],
        );
      });

      // The good primitive should still fire; the borked one is skipped
      // with a warning rather than crashing the loader.
      const result = await runAuthoringPrimitives({
        docoId: DOCO_ID,
        candidate: {
          id: "action_01TESTBORKED0000000000000001",
          neuron_type: "action",
          doco_id: DOCO_ID,
          // actor_id missing → still tripped by the good primitive
        },
      });

      expect(result.blocking?.primitive_id).toBe(PRIMITIVE_ID_FIELD);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`dropping primitive ${malformedId}`),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects a graph-completeness check whose covering neuron is RETIRED", async () => {
    // Defends fix #6 (population side): loadPopulation previously selected
    // all neurons regardless of lifecycle. A retired covering neuron
    // therefore still satisfied a graph-completeness check. Now retired
    // neurons drop out of the population, so the check fails — consistent
    // with the principals filter.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'gc-org', 'GC Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, name, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'gc-test', 'GC Test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
      await c.query(
        `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
           VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
        [PRINCIPAL_ALICE, DOCO_ID],
      );
      // graph-completeness primitive: every id in `actors` on an Intent
      // must be covered by an incoming Action with synapse_type=performed_by
      // whose actor_id equals that id.
      const yaml = JSON.stringify({
        id: PRIMITIVE_ID_PRINCIPAL,
        summary: "Intent.actors are covered by Actions",
        predicate: {
          kind: "graph-completeness",
          list_field: "actors",
          synapse_type: "performed_by",
          incoming_neuron_type: "action",
          incoming_field_must_match: "actor_id",
          when_neuron_type: ["intent"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO neuron_authoring_primitives
           (id, doco_id, summary, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'active', now(), now())`,
        [PRIMITIVE_ID_PRINCIPAL, DOCO_ID, "Intent.actors are covered by Actions", yaml],
      );
    });

    // Persist a *retired* covering action via upsertEntity (mirrors what a
    // capture would do). Synapse derivation runs at indexer time, but the
    // population query reads from the actions table — so we also seed the
    // synapse row directly.
    const coveringActionId = "action_01TESTCOVER000000000000001";
    const intentId = "intent_01TESTINTENTCOVERED00000001";
    await upsertEntity({
      id: coveringActionId,
      doco_id: DOCO_ID,
      entity_type: "action",
      data: {
        id: coveringActionId,
        neuron_type: "action",
        doco_id: DOCO_ID,
        action: "do work",
        verb: "do",
        actor_id: PRINCIPAL_ALICE,
        lifecycle: "retired",
      },
    });
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO synapses (doco_id, from_id, to_id, from_neuron_type, to_neuron_type, synapse_type)
           VALUES ($1, $2, $3, 'action', 'intent', 'performed_by')`,
        [DOCO_ID, coveringActionId, intentId],
      );
    });

    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: intentId,
        neuron_type: "intent",
        doco_id: DOCO_ID,
        intent: "ship the thing",
        actors: [PRINCIPAL_ALICE],
      },
    });

    // The covering Action is retired, so it falls out of the population
    // and the completeness check fails.
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.predicate_kind).toBe("graph-completeness");
  });

  it("rejects a candidate whose actor_id resolves to a RETIRED principal", async () => {
    // Defends fix #6: loadPrincipals previously selected every principal
    // regardless of lifecycle, so a retired actor still satisfied
    // requires_field_resolves_to_principal. Now the loader filters to
    // active so the predicate behaves consistently with the rest of the
    // codebase's active-only semantics.
    await seed({ withPrincipalRule: true });
    const retiredPrincipal = "principal_01TESTRETIRED0000000000001";
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO principals (id, doco_id, name, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, 'old-bot', '{}'::jsonb, 'retired', now(), now())`,
        [retiredPrincipal, DOCO_ID],
      );
    });

    const result = await runAuthoringPrimitives({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTRETIREDACTOR000000001",
        neuron_type: "action",
        doco_id: DOCO_ID,
        verb: "send",
        actor_id: retiredPrincipal,
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.predicate_kind).toBe("requires_field_resolves_to_principal");
    expect(result.blocking?.reason).toMatch(/does not resolve/);
  });
});

describe("captureNeuronAuthoringPrimitive — synapse_type validation", () => {
  async function seedDoco(): Promise<void> {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'val-org', 'Val Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, name, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'val-test', 'Val Test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
      await c.query(
        `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
           VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
        [PRINCIPAL_ALICE, DOCO_ID],
      );
    });
  }

  function draft(
    predicate: Record<string, unknown>,
    summary = "test predicate",
  ): NeuronAuthoringPrimitiveDraft {
    return {
      summary,
      evaluation_kind: "deterministic",
      predicate: predicate as never,
      on_violation: "block",
      authored_by_principal_id: PRINCIPAL_ALICE,
    };
  }

  it("rejects a requires_synapse predicate whose synapse_type is a field name", async () => {
    // Defends fix #11: a predicate that says synapse_type = "intent_ids"
    // (the field name) would never match because deriveSynapses rewrites
    // the field name to "serves". The validator now catches this at
    // capture time and surfaces the canonical name.
    await seedDoco();
    const result = await captureNeuronAuthoringPrimitive(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "requires_synapse", synapse_type: "intent_ids" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/intent_ids/);
      expect(result.error).toMatch(/serves/);
    }
  });

  it("rejects a forbids_synapse predicate whose synapse_type is a SKIP_FIELDS field", async () => {
    // Defends fix #10/#11: deriveSynapses skips `inputs`, so a synapse
    // with that type can never exist. The validator surfaces this rather
    // than letting the primitive sit silently dead.
    await seedDoco();
    const result = await captureNeuronAuthoringPrimitive(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "forbids_synapse", synapse_type: "inputs" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/SKIP_FIELDS/);
    }
  });

  it("accepts a requires_synapse predicate with a canonical synapse_type", async () => {
    await seedDoco();
    const result = await captureNeuronAuthoringPrimitive(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "requires_synapse", synapse_type: "serves" }),
    );
    expect("error" in result).toBe(false);
  });
});

describe("upsertEntity — lifecycle column / data.lifecycle drift", () => {
  it("derives the lifecycle column from data.lifecycle (ignoring the rec.lifecycle param)", async () => {
    // Defends fix #3: the lifecycle column is a denormalized mirror of
    // data.lifecycle. The runner's loader filters on the column, so any
    // drift silently disables enforcement. The upsert now derives the
    // column from data; a disagreeing rec.lifecycle is logged and the
    // data value wins.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'drift-org', 'Drift Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, name, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'drift-test', 'Drift Test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
    });

    const id = "rule_01TESTDRIFT00000000000000001";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Disagreeing rec.lifecycle vs data.lifecycle. data wins; the
      // column reflects "retired" even though the caller asked for
      // "active".
      await upsertEntity({
        id,
        doco_id: DOCO_ID,
        entity_type: "rule",
        lifecycle: "active",
        data: {
          id,
          neuron_type: "rule",
          doco_id: DOCO_ID,
          rule: "drift example",
          lifecycle: "retired",
        },
      });

      const row = await withClient((c) =>
        c.query<{ lifecycle: string | null; data: { lifecycle?: string } }>(
          "SELECT lifecycle, data FROM rules WHERE id = $1",
          [id],
        ),
      );
      expect(row.rows[0]?.lifecycle).toBe("retired");
      expect(row.rows[0]?.data.lifecycle).toBe("retired");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lifecycle mismatch"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
