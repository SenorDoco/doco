import { upsertEntity, withClient } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAuthoringPolicies } from "../authoring-runner.server";
import { type NodeAuthoringPolicyDraft, captureNodeAuthoringPolicy } from "../capture.server";
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
const POLICY_ID_PRINCIPAL = "node_authoring_policy_01TESTPRINCIPAL000000001";
const POLICY_ID_FIELD = "node_authoring_policy_01TESTFIELD000000000001";
const POLICY_ID_PROBABILISTIC = "node_authoring_policy_01TESTPROB0000000000001";
const POLICY_ID_UNIQUE = "node_authoring_policy_01TESTUNIQUE00000000001";
const POLICY_ID_ALLOWLIST = "node_authoring_policy_01TESTALLOWLIST000000001";

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
    // Insert an organization — required for the FK on docos.org_id.
    await c.query(
      `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
         VALUES ($1, 'test-org', 'Test Org', '{}'::jsonb, now(), now())`,
      [ORG_ID],
    );

    // Insert a doco — required for the FK on node_authoring_policies.
    await c.query(
      `INSERT INTO docos (id, handle, owner_id, org_id, data, created_at, updated_at)
         VALUES ($1, 'smoke-test', $2, $2, '{}'::jsonb, now(), now())`,
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
        id: POLICY_ID_PRINCIPAL,
        doco_id: DOCO_ID,
        node_type: "node_authoring_policy",
        policy_kind: "node_authoring",
        policy: "Action.actor_id resolves to a Principal",
        evaluation_kind: "deterministic",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_node_type: ["action"],
        },
        on_violation: "block",
        ...(opts.firesOnActive ? { fires_when_node_lifecycle: ["asserted"] } : {}),
      });
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
        [POLICY_ID_PRINCIPAL, DOCO_ID, "Action.actor_id resolves to a Principal", yaml],
      );
    }

    if (opts.withRequiredFieldRule) {
      const yaml = JSON.stringify({
        id: POLICY_ID_FIELD,
        doco_id: DOCO_ID,
        node_type: "node_authoring_policy",
        policy_kind: "node_authoring",
        policy: "Action.actor_id is set",
        evaluation_kind: "deterministic",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_node_type: ["action"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
        [POLICY_ID_FIELD, DOCO_ID, "Action.actor_id is set", yaml],
      );
    }

    if (opts.withProbabilisticRule) {
      const yaml = JSON.stringify({
        id: POLICY_ID_PROBABILISTIC,
        doco_id: DOCO_ID,
        node_type: "node_authoring_policy",
        policy_kind: "node_authoring",
        policy: "Action prose is atomic",
        evaluation_kind: "probabilistic",
        predicate: {
          kind: "probabilistic",
          spec: "The Action's `action` field reads as an atomic business activity, not a vague umbrella phase.",
          when_node_type: ["action"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
        [POLICY_ID_PROBABILISTIC, DOCO_ID, "Action prose is atomic", yaml],
      );
    }

    if (opts.withEntityTypeAllowlist) {
      const yaml = JSON.stringify({
        id: POLICY_ID_ALLOWLIST,
        doco_id: DOCO_ID,
        node_type: "node_authoring_policy",
        policy_kind: "node_authoring",
        policy: "Only intent/decision/principal belong here",
        evaluation_kind: "deterministic",
        predicate: {
          kind: "requires_entity_type",
          entity_types: ["intent", "decision", "principal"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
        [POLICY_ID_ALLOWLIST, DOCO_ID, "Only intent/decision/principal belong here", yaml],
      );
    }

    if (opts.withUniqueFieldRule) {
      const yaml = JSON.stringify({
        id: POLICY_ID_UNIQUE,
        doco_id: DOCO_ID,
        node_type: "node_authoring_policy",
        policy_kind: "node_authoring",
        policy: "Decision.chosen is unique",
        evaluation_kind: "deterministic",
        predicate: {
          kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: ["asserted"],
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
        [POLICY_ID_UNIQUE, DOCO_ID, "Decision.chosen is unique", yaml],
      );
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
    expect(result.blocking?.predicate_kind).toBe("requires_field_resolves_to_principal");
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
    expect(result.blocking?.predicate_kind).toBe("requires_field");
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
    expect(result.blocking?.predicate_kind).toBe("probabilistic");
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

  it("demotes block to warn when the judge is unavailable (returns null)", async () => {
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
    expect(result.blocking).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.predicate_kind).toBe("probabilistic");
    expect(result.warnings[0]?.on_violation).toBe("warn");
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
    expect(result.blocking?.predicate_kind).toBe("requires_entity_type");
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
    await upsertEntity({
      id: existingId,
      doco_id: DOCO_ID,
      entity_type: "decision",
      data: {
        id: existingId,
        node_type: "decision",
        doco_id: DOCO_ID,
        decision: "Activation key means the code used to activate an account.",
        question: "What does activation key mean?",
        chosen: "Activation key",
        decided_by: PRINCIPAL_ALICE,
        decided_at: new Date().toISOString(),
        lifecycle: "asserted",
      },
    });

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
        lifecycle: "asserted",
      },
    });

    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.predicate_kind).toBe("unique_field");
    expect(result.blocking?.policy_id).toBe(POLICY_ID_UNIQUE);
    expect(result.blocking?.reason).toMatch(existingId);
  });

  it("loads policies whose lifecycle column is NULL (treated as accepted)", async () => {
    // Defends fix #1: loadPolicies used WHERE lifecycle = 'asserted' (strict)
    // while the rest of the codebase uses COALESCE(lifecycle, 'asserted') =
    // 'asserted'. A policy with a NULL lifecycle column was silently
    // invisible to the enforcer.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'null-life-org', 'Null-Life Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'null-life', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
      const yaml = JSON.stringify({
        id: POLICY_ID_FIELD,
        summary: "Action.actor_id is set",
        predicate: { kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] },
        on_violation: "block",
      });
      // Explicit NULL on the lifecycle column — should still load because
      // the loader COALESCEs NULL → 'asserted'.
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NULL, now(), now())`,
        [POLICY_ID_FIELD, DOCO_ID, "Action.actor_id is set", yaml],
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
      const malformedId = "node_authoring_policy_01TESTBORKED00000000000001";
      await withClient(async (c) => {
        await c.query(
          `INSERT INTO node_authoring_policies
             (id, doco_id, policy, data, lifecycle, created_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
          [
            malformedId,
            DOCO_ID,
            "Borked",
            JSON.stringify({ summary: "Borked", predicate: "not-an-object" }),
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
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'gc-org', 'GC Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'gc-test', $2, $2, '{}'::jsonb, now(), now())`,
        [DOCO_ID, ORG_ID],
      );
      await c.query(
        `INSERT INTO principals (id, doco_id, name, data, created_at, updated_at)
           VALUES ($1, $2, 'alice', '{}'::jsonb, now(), now())`,
        [PRINCIPAL_ALICE, DOCO_ID],
      );
      // graph-completeness policy: every id in `actors` on an Intent
      // must be covered by an incoming Action with a canonical supports edge
      // whose actor_id equals that id.
      const yaml = JSON.stringify({
        id: POLICY_ID_PRINCIPAL,
        summary: "Intent.actors are covered by Actions",
        predicate: {
          kind: "graph-completeness",
          list_field: "actors",
          edge_type: "supports",
          incoming_node_type: "action",
          incoming_field_must_match: "actor_id",
          when_node_type: ["intent"],
        },
        on_violation: "block",
      });
      await c.query(
        `INSERT INTO node_authoring_policies
           (id, doco_id, policy, data, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, 'asserted', now(), now())`,
        [POLICY_ID_PRINCIPAL, DOCO_ID, "Intent.actors are covered by Actions", yaml],
      );
    });

    // Persist a *retired* covering action via upsertEntity (mirrors what a
    // capture would do). Edge derivation runs at indexer time, but the
    // population query reads from the actions table — so we also seed the
    // edge row directly.
    const coveringActionId = "action_01TESTCOVER000000000000001";
    const intentId = "intent_01TESTINTENTCOVERED00000001";
    await upsertEntity({
      id: coveringActionId,
      doco_id: DOCO_ID,
      entity_type: "action",
      data: {
        id: coveringActionId,
        node_type: "action",
        doco_id: DOCO_ID,
        action: "do work",
        verb: "do",
        actor_id: PRINCIPAL_ALICE,
        lifecycle: "retired",
      },
    });
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
    expect(result.blocking?.predicate_kind).toBe("requires_field_resolves_to_principal");
    expect(result.blocking?.reason).toMatch(/does not resolve/);
  });
});

describe("captureNodeAuthoringPolicy — edge_type validation", () => {
  async function seedDoco(): Promise<void> {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
           VALUES ($1, 'val-org', 'Val Org', '{}'::jsonb, now(), now())`,
        [ORG_ID],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'val-test', $2, $2, '{}'::jsonb, now(), now())`,
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
    policyText = "test predicate",
  ): NodeAuthoringPolicyDraft {
    return {
      policy: policyText,
      evaluation_kind: "deterministic",
      predicate: predicate as never,
      on_violation: "block",
      authored_by_principal_id: PRINCIPAL_ALICE,
    };
  }

  it("rejects a requires_edge predicate whose edge_type is a blocked node JSON edge key", async () => {
    await seedDoco();
    const result = await captureNodeAuthoringPolicy(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "requires_edge", edge_type: "intent_ids" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/intent_ids/);
      expect(result.error).toMatch(/first-class edge type/);
    }
  });

  it("rejects a forbids_edge predicate with a non-canonical edge_type", async () => {
    await seedDoco();
    const result = await captureNodeAuthoringPolicy(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "forbids_edge", edge_type: "inputs" }),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/inputs/);
      expect(result.error).toMatch(/Valid edge types:/);
    }
  });

  it("accepts a requires_edge predicate with a canonical edge_type", async () => {
    await seedDoco();
    const result = await captureNodeAuthoringPolicy(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "requires_edge", edge_type: "supports" }),
    );
    expect("error" in result).toBe(false);
  });

  it("rejects another blocked node JSON edge key", async () => {
    await seedDoco();
    const result = await captureNodeAuthoringPolicy(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({ kind: "requires_edge", edge_type: "preceded_by" }),
    );
    expect("error" in result).toBe(true);
  });

  it("rejects a graph-completeness predicate with a role label edge_type", async () => {
    await seedDoco();
    const result = await captureNodeAuthoringPolicy(
      "",
      DOCO_ID,
      "val-org",
      "val-test",
      draft({
        kind: "graph-completeness",
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
        `INSERT INTO docos (id, handle, owner_id, org_id, data, created_at, updated_at)
           VALUES ($1, 'drift-test', $2, $2, '{}'::jsonb, now(), now())`,
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
        lifecycle: "asserted",
        data: {
          id,
          node_type: "rule",
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
