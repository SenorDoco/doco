import { withClient } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAuthoringPrimitives } from "../authoring-runner.server";
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

    // Insert a Principal (Alice).
    await c.query(
      `INSERT INTO principals (id, username, data, created_at, updated_at)
         VALUES ($1, 'alice', '{}'::jsonb, now(), now())`,
      [PRINCIPAL_ALICE],
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
        lifecycle: "drafted",
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
});
