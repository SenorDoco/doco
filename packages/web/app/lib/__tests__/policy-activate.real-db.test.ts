// Re-activating a retired policy, against a real DB.
//
// The reported bug: a policy that has been retired (e.g. the single-intent
// ceiling that re-seed churn wound down) cannot be turned back on from the edit
// page. `transitionPolicyLifecycle` is the seam the new "Activate" button calls;
// this pins that it flips `retired → active` and, because an active policy is by
// definition not superseded, that it clears any stale `superseded_by` pointer.
//
// Points `@doco/db`'s `withClient` at an in-process PGlite loaded with the real
// schema.sql; the only stubbed boundary is the audit-log sink (file IO).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("../audit-log.server", () => ({ appendAuditEvent: vi.fn() }));

import { transitionPolicyLifecycle } from "../capture.server";

const DOCO = "doco_01TESTACTIVATE0000000001";

async function seedRetiredPolicy(id: string, data: Record<string, unknown>): Promise<void> {
  await dbm.db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'deterministic', $3::jsonb, 'retired')`,
    [id, DOCO, JSON.stringify({ ...data, id, doco_id: DOCO, lifecycle: "retired" })],
  );
}

async function readPolicy(
  id: string,
): Promise<{ lifecycle: string; data: Record<string, unknown> }> {
  const r = await dbm.db.query<{ lifecycle: string; data: Record<string, unknown> }>(
    "SELECT lifecycle, data FROM policies WHERE id = $1",
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`policy ${id} not found`);
  const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Record<
    string,
    unknown
  >;
  return { lifecycle: row.lifecycle, data };
}

describe("transitionPolicyLifecycle — re-activating a retired policy", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    await dbm.db.exec(schemaSql);
    await dbm.db.exec(`
      INSERT INTO workspaces (id, handle, name, data)
        VALUES ('workspace_test', 'ws', 'WS', '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
      INSERT INTO docos (id, handle, owner_id, workspace_id, data)
        VALUES ('${DOCO}', 'd', 'workspace_test', 'workspace_test', '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  it("flips a retired policy back to active (both column and data blob)", async () => {
    const id = "policy_01TESTRETIREDCEILING00001";
    await seedRetiredPolicy(id, {
      kind: "deterministic",
      predicate: {
        sub_kind: "limits_edge",
        edge_type: "supports",
        target_node_type: "intent",
        max_count: 1,
      },
    });
    const result = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: DOCO,
      policyId: id,
      newLifecycle: "active",
      actorId: null,
    });
    expect("ok" in result).toBe(true);
    const row = await readPolicy(id);
    expect(row.lifecycle).toBe("active");
    expect(row.data.lifecycle).toBe("active");
  });

  it("clears a stale superseded_by pointer when re-activating", async () => {
    const id = "policy_01TESTSUPERSEDED00000001";
    await seedRetiredPolicy(id, {
      kind: "deterministic",
      predicate: { sub_kind: "requires_field", fields: ["name"] },
      superseded_by: "policy_01SOMENEWERONE0000000001",
    });
    await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: DOCO,
      policyId: id,
      newLifecycle: "active",
      actorId: null,
    });
    const row = await readPolicy(id);
    expect(row.lifecycle).toBe("active");
    expect("superseded_by" in row.data).toBe(false);
  });

  it("still records superseded_by when retiring via supersession", async () => {
    const id = "policy_01TESTACTIVEONE000000001";
    await dbm.db.query(
      `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
         VALUES ($1, $2, 'deterministic', $3::jsonb, 'active')`,
      [
        id,
        DOCO,
        JSON.stringify({
          id,
          doco_id: DOCO,
          kind: "deterministic",
          predicate: { sub_kind: "requires_field", fields: ["name"] },
          lifecycle: "active",
        }),
      ],
    );
    await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: DOCO,
      policyId: id,
      newLifecycle: "retired",
      supersededBy: "policy_01TESTNEWERONE0000000001",
      actorId: null,
    });
    const row = await readPolicy(id);
    expect(row.lifecycle).toBe("retired");
    expect(row.data.superseded_by).toBe("policy_01TESTNEWERONE0000000001");
  });
});
