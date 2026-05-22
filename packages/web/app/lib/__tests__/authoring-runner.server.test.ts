import { withClient } from "@doco/db";
import { describe, expect, it } from "vitest";
import { runAuthoringPrimitives } from "../authoring-runner.server";

// Required test DB lifecycle hooks (beforeAll/beforeEach/afterAll).
import "./db-isolation";

const DOCO_ID = "doco_01TEST00000000000000000001";
const PRINCIPAL_ALICE = "principal_01TESTALICE0000000000001";
const PRIMITIVE_ID_PRINCIPAL = "neuron_authoring_primitive_01TESTPRINCIPAL000000001";
const PRIMITIVE_ID_FIELD = "neuron_authoring_primitive_01TESTFIELD000000000001";

interface SeedOpts {
  withPrincipalRule?: boolean;
  withRequiredFieldRule?: boolean;
  firesOnActive?: boolean;
}

async function seed(opts: SeedOpts = {}): Promise<void> {
  await withClient(async (c) => {
    // Insert a doco — required for the FK on neuron_authoring_primitives.
    // Use the data jsonb column directly so the test works regardless of
    // migration order (the column is `data` post-014).
    await c.query(
      `INSERT INTO docos (id, handle, name, owner_id, data, created_at, updated_at)
         VALUES ($1, 'smoke-test', 'Smoke Test', $2, '{}'::jsonb, now(), now())`,
      [DOCO_ID, PRINCIPAL_ALICE],
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
});
