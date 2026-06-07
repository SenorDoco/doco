import { nodeRowFromFields, upsertNode, withClient } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAuthoringPolicies } from "../authoring-runner.server";
import { type PolicyDraft, capturePolicy } from "../capture.server";
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
const WORKSPACE_ID = "workspace_01TESTWS000000000000001";
const PRINCIPAL_ALICE = "principal_01TESTALICE0000000000001";
const POLICY_ID_PRINCIPAL = "policy_01TESTPRINCIPAL000000001";
const POLICY_ID_FIELD = "policy_01TESTFIELD000000000001";
const POLICY_ID_PROBABILISTIC = "policy_01TESTPROB0000000000001";
const POLICY_ID_UNIQUE = "policy_01TESTUNIQUE00000000001";
const POLICY_ID_ALLOWLIST = "policy_01TESTALLOWLIST000000001";

// Insert a policy row in the new unified shape: a standalone `kind` column +
// a `data` jsonb carrying `kind` and the `predicate`.
async function insertPolicy(
  c: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  id: string,
  kind: "suggestion" | "deterministic" | "probabilistic",
  data: Record<string, unknown>,
  lifecycle: string | null = "active",
): Promise<void> {
  await c.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now(), now())`,
    [id, DOCO_ID, kind, JSON.stringify({ id, doco_id: DOCO_ID, kind, ...data }), lifecycle],
  );
}

interface SeedOpts {
  withPrincipalRule?: boolean;
  withRequiredFieldRule?: boolean;
  withProbabilisticRule?: boolean;
  withUniqueFieldRule?: boolean;
  /** A requires_entity_type membership gate allowing only intent/decision/principal
   *  (notably NOT action) — a lifecycle-independent invariant. */
  withEntityTypeAllowlist?: boolean;
  firesOnActive?: boolean;
}

async function seed(opts: SeedOpts = {}): Promise<void> {
  await withClient(async (c) => {
    // Insert an workspace — required for the FK on docos.workspace_id.
    await c.query(
      `INSERT INTO workspaces (id, handle, name, created_at, updated_at) VALUES ($1, 'test-workspace', 'Test Workspace', now(), now())`,
      [WORKSPACE_ID],
    );

    // Insert a doco — required for the FK on policies.
    await c.query(
      `INSERT INTO docos (id, handle, owner_id, workspace_id, data, created_at, updated_at)
         VALUES ($1, 'smoke-test', $2, $2, '{}'::jsonb, now(), now())`,
      [DOCO_ID, WORKSPACE_ID],
    );

    // Insert a Principal (Alice) scoped to the test Doco.
    await c.query(
      `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
         VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
      [PRINCIPAL_ALICE, DOCO_ID],
    );

    if (opts.withPrincipalRule) {
      await insertPolicy(c, POLICY_ID_PRINCIPAL, "deterministic", {
        predicate: {
          sub_kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_node_type: ["action"],
        },
        on_violation: "block",
        ...(opts.firesOnActive ? { fires_when_node_lifecycle: ["active"] } : {}),
      });
    }

    if (opts.withRequiredFieldRule) {
      await insertPolicy(c, POLICY_ID_FIELD, "deterministic", {
        predicate: {
          sub_kind: "requires_field",
          fields: ["actor_id"],
          when_node_type: ["action"],
        },
        on_violation: "block",
      });
    }

    if (opts.withProbabilisticRule) {
      await insertPolicy(c, POLICY_ID_PROBABILISTIC, "probabilistic", {
        predicate: {
          agent_instruction:
            "The Action's `action` field reads as an atomic business activity, not a vague umbrella phase.",
          when_node_type: ["action"],
        },
        on_violation: "block",
      });
    }

    if (opts.withEntityTypeAllowlist) {
      await insertPolicy(c, POLICY_ID_ALLOWLIST, "deterministic", {
        predicate: {
          sub_kind: "requires_entity_type",
          entity_types: ["intent", "decision", "principal"],
        },
        on_violation: "block",
      });
    }

    if (opts.withUniqueFieldRule) {
      await insertPolicy(c, POLICY_ID_UNIQUE, "deterministic", {
        predicate: {
          sub_kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: ["active"],
        on_violation: "block",
      });
    }
  });
}

describe("authoring runner — integration", () => {
  it("blocks an Action whose actor_id does not resolve to a Principal", async () => {
    await seed({ withPrincipalRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTBAD000000000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        actor_id: "principal_01GHOST000000000000000001",
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.sub_kind).toBe("requires_field_resolves_to_principal");
    expect(result.blocking?.policy_id).toBe(POLICY_ID_PRINCIPAL);
    expect(result.blocking?.reason).toMatch(/principal_01GHOST/);
    expect(result.blocking?.reason).toMatch(/does not resolve/);
    expect(result.evaluated).toBe(1);
    expect(result.passed).toBe(0);
  });

  it("passes an Action whose actor_id resolves to a known Principal", async () => {
    await seed({ withPrincipalRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTGOOD00000000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        actor_id: PRINCIPAL_ALICE,
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.evaluated).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("blocks an Action with no actor_id at all (requires_field)", async () => {
    await seed({ withRequiredFieldRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTNOACTOR00000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        // actor_id intentionally omitted.
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.sub_kind).toBe("requires_field");
    expect(result.blocking?.policy_id).toBe(POLICY_ID_FIELD);
  });

  it("skips a policy whose fires_when_node_lifecycle excludes the candidate", async () => {
    await seed({ withPrincipalRule: true, firesOnActive: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTDRAFTED00000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        actor_id: "principal_01GHOST000000000000000001",
        lifecycle: "drafting",
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.evaluated).toBe(0);
    expect(result.passed).toBe(0);
  });

  it("returns nothing when the doco has no active policies", async () => {
    await seed({}); // no policies
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTNOPRIMS00000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        actor_id: "principal_01GHOST000000000000000001",
      },
    });

    expect(result.violations).toEqual([]);
    expect(result.blocking).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.evaluated).toBe(0);
    expect(result.passed).toBe(0);
  });

  it("blocks an Action when the LLM judge rejects a probabilistic predicate", async () => {
    mockedJudge.mockResolvedValue({
      ok: false,
      reason: "summary 'handle order' is a vague umbrella phase",
    });
    await seed({ withProbabilisticRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTVAGUE000000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        summary: "handle order",
        verb: "handle",
      },
    });

    expect(mockedJudge).toHaveBeenCalledTimes(1);
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.kind).toBe("probabilistic");
    expect(result.blocking?.policy_id).toBe(POLICY_ID_PROBABILISTIC);
    expect(result.blocking?.reason).toMatch(/umbrella phase/);
  });

  it("passes when the LLM judge approves a probabilistic predicate", async () => {
    mockedJudge.mockResolvedValue({ ok: true });
    await seed({ withProbabilisticRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTATOMIC00000000000001",
        node_type: "action",
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

  it("blocks with an error when the judge is unavailable (returns null)", async () => {
    mockedJudge.mockResolvedValue(null);
    await seed({ withProbabilisticRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTJUDGEDOWN000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        summary: "handle order",
        verb: "handle",
      },
    });

    expect(mockedJudge).toHaveBeenCalledTimes(1);
    // Fail closed: a judge outage blocks the capture with an actionable error
    // instead of silently demoting the unchecked policy to a warning.
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.kind).toBe("probabilistic");
    expect(result.blocking?.on_violation).toBe("block");
    expect(result.blocking?.reason).toMatch(/could not be checked/i);
    expect(result.warnings).toEqual([]);
  });

  it("skips shape/completeness enforcement when the candidate is transitioning to retired", async () => {
    // Reported in chat: a probabilistic policy (no fires_when_node_lifecycle
    // filter) blocked a State's retirement because the current content didn't
    // satisfy a quality rule. Retiring is a winding-down operation — the runner
    // should let shape/completeness rules pass on the way out. (Type/membership
    // invariants are a different story — see the next test.)
    await seed({ withPrincipalRule: true, withRequiredFieldRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTRETIRE00000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        // Both rules above would fire on this candidate at active —
        // requires_field on missing actor_id, requires_field_resolves_to_principal
        // would also fail. But the lifecycle is retired, so these shape gates
        // don't fire.
        lifecycle: "retired",
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("STILL enforces type/membership invariants on a retired candidate", async () => {
    // Fix #1: a node that defaults to a terminal lifecycle (Actions/Logs
    // default `retired`) must not slip past a template's entity-type
    // allowlist. requires_entity_type is lifecycle-independent — it
    // describes what may exist in the Doco at all, not what an *active*
    // node must look like — so it fires even on a retired candidate.
    await seed({ withEntityTypeAllowlist: true, withRequiredFieldRule: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTRETIREDLEAK0000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        action: "send invoice",
        verb: "send",
        actor_id: PRINCIPAL_ALICE,
        lifecycle: "retired",
      },
    });

    // The allowlist (intent/decision/principal) blocks the action even
    // though it's retired; the shape gate (requires_field) is skipped, so
    // the only evaluated/blocking policy is the membership invariant.
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.sub_kind).toBe("requires_entity_type");
    expect(result.blocking?.policy_id).toBe(POLICY_ID_ALLOWLIST);
    expect(result.evaluated).toBe(1);
  });

  it("passes a retired candidate of an ALLOWED type through the membership gate", async () => {
    // The same allowlist admits a retired Decision (an allowed type), so
    // closing out a stale-but-valid node isn't blocked.
    await seed({ withEntityTypeAllowlist: true });
    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "decision_01TESTRETIREDOK000000000001",
        node_type: "decision",
        doco_id: DOCO_ID,
        decision: "old call",
        question: "?",
        chosen: "x",
        decided_by: PRINCIPAL_ALICE,
        lifecycle: "retired",
      },
    });

    expect(result.blocking).toBeNull();
    expect(result.evaluated).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("blocks a unique_field duplicate by loading the active population", async () => {
    await seed({ withUniqueFieldRule: true });
    const existingId = "decision_01TESTTERMEXISTING000000001";
    await upsertNode(
      nodeRowFromFields("decision", {
        id: existingId,
        node_type: "decision",
        doco_id: DOCO_ID,
        decision: "Activation key means the code used to activate an account.",
        question: "What does activation key mean?",
        chosen: "Activation key",
        decided_by: PRINCIPAL_ALICE,
        decided_at: new Date().toISOString(),
        lifecycle: "active",
      }),
    );

    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "decision_01TESTTERMDUPLICATE0000001",
        node_type: "decision",
        doco_id: DOCO_ID,
        decision: "Duplicate glossary term.",
        question: "What does activation key mean?",
        chosen: " activation KEY ",
        decided_by: PRINCIPAL_ALICE,
        lifecycle: "active",
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.sub_kind).toBe("unique_field");
    expect(result.blocking?.policy_id).toBe(POLICY_ID_UNIQUE);
    expect(result.blocking?.reason).toMatch(existingId);
  });

  it("loads policies whose lifecycle column is NULL (treated as accepted)", async () => {
    // Defends fix #1: loadPolicies used WHERE lifecycle = 'active' (strict)
    // while the rest of the codebase uses COALESCE(lifecycle, 'active') =
    // 'active'. A policy with a NULL lifecycle column was silently
    // invisible to the enforcer.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO workspaces (id, handle, name, created_at, updated_at) VALUES ($1, 'null-life-workspace', 'Null-Life Workspace', now(), now())`,
        [WORKSPACE_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, workspace_id, data, created_at, updated_at)
           VALUES ($1, 'null-life', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, WORKSPACE_ID],
      );
      // Explicit NULL on the lifecycle column — should still load because
      // the loader COALESCEs NULL → 'active'.
      await insertPolicy(
        c,
        POLICY_ID_FIELD,
        "deterministic",
        {
          predicate: {
            sub_kind: "requires_field",
            fields: ["actor_id"],
            when_node_type: ["action"],
          },
          on_violation: "block",
        },
        null,
      );
    });

    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTNULL00000000000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        // actor_id missing → should trip the policy
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.policy_id).toBe(POLICY_ID_FIELD);
  });

  it("warns and drops a policy whose persisted predicate is malformed", async () => {
    // Defends fix #2: a policy row whose `data.predicate` is not a JSON
    // object was silently skipped with no log. Now we console.warn so the
    // operator can spot it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seed({ withRequiredFieldRule: true });
      const malformedId = "policy_01TESTBORKED00000000000001";
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO policies
             (id, doco_id, kind, data, lifecycle, created_at, updated_at)
             VALUES ($1, $2, 'deterministic', $3::jsonb, 'active', now(), now())`,
          [
            malformedId,
            DOCO_ID,
            JSON.stringify({ id: malformedId, kind: "deterministic", predicate: "not-an-object" }),
          ],
        );
      });

      // The good policy should still fire; the borked one is skipped
      // with a warning rather than crashing the loader.
      const result = await runAuthoringPolicies({
        docoId: DOCO_ID,
        candidate: {
          id: "action_01TESTBORKED0000000000000001",
          node_type: "action",
          doco_id: DOCO_ID,
          // actor_id missing → still tripped by the good policy
        },
      });

      expect(result.blocking?.policy_id).toBe(POLICY_ID_FIELD);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`dropping policy ${malformedId}`),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects a graph-completeness check whose covering node is RETIRED", async () => {
    // Defends fix #6 (population side): loadPopulation previously selected
    // all nodes regardless of lifecycle. A retired covering node
    // therefore still satisfied a graph-completeness check. Now retired
    // nodes drop out of the population, so the check fails — consistent
    // with the principals filter.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO workspaces (id, handle, name, created_at, updated_at) VALUES ($1, 'gc-workspace', 'GC Workspace', now(), now())`,
        [WORKSPACE_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, workspace_id, data, created_at, updated_at)
           VALUES ($1, 'gc-test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, WORKSPACE_ID],
      );
      await c.query(
        `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
           VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
        [PRINCIPAL_ALICE, DOCO_ID],
      );
      // graph-completeness policy: every id in `actors` on an Intent
      // must be covered by an incoming Action with a canonical supports edge
      // whose actor_id equals that id.
      await insertPolicy(c, POLICY_ID_PRINCIPAL, "deterministic", {
        predicate: {
          sub_kind: "graph-completeness",
          list_field: "actors",
          edge_type: "supports",
          incoming_node_type: "action",
          incoming_field_must_match: "actor_id",
          when_node_type: ["intent"],
        },
        on_violation: "block",
      });
    });

    // Persist a *retired* covering action via upsertEntity (mirrors what a
    // capture would do). Edge derivation runs at indexer time, but the
    // population query reads from the actions table — so we also seed the
    // edge row directly.
    const coveringActionId = "action_01TESTCOVER000000000000001";
    const intentId = "intent_01TESTINTENTCOVERED00000001";
    await upsertNode(
      nodeRowFromFields("action", {
        id: coveringActionId,
        node_type: "action",
        doco_id: DOCO_ID,
        action: "do work",
        verb: "do",
        actor_id: PRINCIPAL_ALICE,
        lifecycle: "retired",
      }),
    );
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO edges (doco_id, from_id, to_id, from_node_type, to_node_type, edge_type, props)
           VALUES ($1, $2, $3, 'action', 'intent', 'supports', '{"role":"serves"}'::jsonb)`,
        [DOCO_ID, coveringActionId, intentId],
      );
    });

    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: intentId,
        node_type: "intent",
        doco_id: DOCO_ID,
        intent: "ship the thing",
        actors: [PRINCIPAL_ALICE],
      },
    });

    // The covering Action is retired, so it falls out of the population
    // and the completeness check fails.
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.sub_kind).toBe("graph-completeness");
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

    const result = await runAuthoringPolicies({
      docoId: DOCO_ID,
      candidate: {
        id: "action_01TESTRETIREDACTOR000000001",
        node_type: "action",
        doco_id: DOCO_ID,
        verb: "send",
        actor_id: retiredPrincipal,
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.sub_kind).toBe("requires_field_resolves_to_principal");
    expect(result.blocking?.reason).toMatch(/does not resolve/);
  });
});

describe("capturePolicy — edge_type validation", () => {
  async function seedDoco(): Promise<void> {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO workspaces (id, handle, name, created_at, updated_at) VALUES ($1, 'val-workspace', 'Val Workspace', now(), now())`,
        [WORKSPACE_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, workspace_id, data, created_at, updated_at)
           VALUES ($1, 'val-test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, WORKSPACE_ID],
      );
      await c.query(
        `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
           VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
        [PRINCIPAL_ALICE, DOCO_ID],
      );
    });
  }

  function draft(predicate: Record<string, unknown>): PolicyDraft {
    return {
      kind: "deterministic",
      predicate: predicate as never,
      on_violation: "block",
      authored_by_principal_id: PRINCIPAL_ALICE,
    };
  }

  it("rejects a requires_edge predicate whose edge_type is a blocked node JSON edge key", async () => {
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({ sub_kind: "requires_edge", edge_type: "intent_ids" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/intent_ids/);
      expect(result.error).toMatch(/first-class edge type/);
    }
  });

  it("rejects a forbids_edge predicate with a non-canonical edge_type", async () => {
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({ sub_kind: "forbids_edge", edge_type: "inputs" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/inputs/);
      expect(result.error).toMatch(/Valid edge types:/);
    }
  });

  it("accepts a requires_edge predicate with a canonical edge_type", async () => {
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({ sub_kind: "requires_edge", edge_type: "supports" }),
    );
    expect("error" in result).toBe(false);
  });

  it("accepts a requires_edge predicate with a canonical edge_type and target_node_type", async () => {
    // With `role` gone, the distinction that used to ride on edge_role lives on
    // target_node_type — a canonical edge_type + endpoint type is accepted.
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({ sub_kind: "requires_edge", edge_type: "supports", target_node_type: "intent" }),
    );
    expect("error" in result).toBe(false);
  });

  it("rejects a requires_edge predicate whose edge_type is the retired role label `implemented_by`", async () => {
    // `implemented_by` was an edge ROLE, never a first-class edge type. With
    // roles gone it must be rejected as an edge_type — the meaning rides on the
    // `supports` edge type plus its endpoints instead.
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({ sub_kind: "requires_edge", edge_type: "implemented_by" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/implemented_by/);
      expect(result.error).toMatch(/first-class edge type/);
    }
  });

  it("rejects another blocked node JSON edge key", async () => {
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({ sub_kind: "requires_edge", edge_type: "preceded_by" }),
    );
    expect("error" in result).toBe(true);
  });

  it("rejects a graph-completeness predicate with a role label edge_type", async () => {
    await seedDoco();
    const result = await capturePolicy(
      "",
      DOCO_ID,
      "val-workspace",
      "val-test",
      draft({
        sub_kind: "graph-completeness",
        list_field: "actors",
        edge_type: "performed_by",
        incoming_node_type: "action",
        incoming_field_must_match: "actor_id",
      }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/performed_by/);
      expect(result.error).toMatch(/Valid edge types:/);
    }
  });
});

// (Removed: the "lifecycle column / data.lifecycle drift" test guarded
// `deriveLifecycleColumn`, the reconciliation between a write record's top-level
// `lifecycle` and its `data.lifecycle`. That dual source only existed for the
// retired `EntityRecord` envelope; nodes now write from a single field bag with
// one `lifecycle`, so the drift it warned about cannot occur. The "the lifecycle
// column mirrors the written value" invariant is pinned in
// packages/db/src/__tests__/category-writers.test.ts.)
