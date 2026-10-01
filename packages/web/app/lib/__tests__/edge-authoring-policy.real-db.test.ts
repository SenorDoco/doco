// Real-DB exercise of the EDGE-scoped authoring policy path.
//
// The `process` template ships a deterministic edge-type allowlist: only the
// BPMN edge families (flows_to / has_parent / supports / attributed_to /
// constrained_by / replaces / derived_from) may be used. `has_parent` is a
// flow node's process membership now, so it is allowed; bare `relates_to`
// links are not.
//
// What runs for real:
//   - the template definition + host seam that seeds the edge policy into the
//     `policies` table (against in-process PGlite loaded with the real schema),
//   - the web edge runner (`runEdgeAuthoringPolicies`) loading + matching that
//     policy and resolving it through the judge boundary.
// Only the LLM judge is stubbed (it can't run offline).

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
const judge = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});
vi.mock("../llm-judge.server", () => ({ judgeProbabilisticPredicate: judge.run }));

import { createDocoInWorkspace } from "@doco/host";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { runEdgeAuthoringPolicies } from "../authoring-runner.server";

const WORKSPACE_ID = "workspace_01EDGEPOL000000000000001";
const USER_ID = "user_01EDGEPOL0000000000000001";

let docoId = "";

beforeAll(async () => {
  dbm.db = await freshDb();
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'edge-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, 'edge-test', 'Edge Test')",
    [WORKSPACE_ID],
  );
  await dbm.db.query(
    "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
    [WORKSPACE_ID, USER_ID],
  );
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "orders",
    createdByUserId: USER_ID,
    templateHandle: "process",
  });
  docoId = created.docoId;
});

beforeEach(() => judge.run.mockReset());

describe("edge-type allowlist (requires_edge_type) — end-to-end via runEdgeAuthoringPolicies", () => {
  // The process template seeds an edge-type allowlist:
  // flows_to / has_parent / supports / attributed_to / constrained_by /
  // replaces / derived_from. It's deterministic (no judge) and a structural
  // gate, so it blocks a disallowed edge type at creation — even for a
  // `drafting` edge.
  it("blocks an edge type not in the allowlist (relates_to), without calling the judge", async () => {
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { edge_type: "relates_to", from_node_type: "action", to_node_type: "action" },
      judgeCandidate: { id: "action_a->action_b", edge_type: "relates_to" },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_edge_type");
    expect(result.blocking?.on_violation).toBe("block");
    expect(result.blocking?.reason).toMatch(/relates_to/);
  });

  it("allows has_parent — a flow node's process membership — without the judge", async () => {
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { edge_type: "has_parent", from_node_type: "action", to_node_type: "action" },
      judgeCandidate: { id: "action_a->action_b", edge_type: "has_parent" },
    });
    expect(result.violations.some((v) => v.sub_kind === "requires_edge_type")).toBe(false);
    expect(result.blocking).toBeNull();
  });

  it("allows an edge type in the allowlist (flows_to)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { edge_type: "flows_to", from_node_type: "action", to_node_type: "state" },
      judgeCandidate: { id: "action_a->state_b", edge_type: "flows_to" },
    });
    expect(result.violations.some((v) => v.sub_kind === "requires_edge_type")).toBe(false);
    expect(result.blocking).toBeNull();
  });

  it("blocks a disallowed edge type even on a drafting edge (includeProbabilistic=false)", async () => {
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { edge_type: "relates_to", from_node_type: "action", to_node_type: "action" },
      judgeCandidate: { id: "action_a->action_b", edge_type: "relates_to" },
      includeProbabilistic: false,
    });
    expect(result.blocking?.sub_kind).toBe("requires_edge_type");
  });
});
