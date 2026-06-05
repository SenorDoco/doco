// Real-DB exercise of the EDGE-scoped authoring policy path.
//
// The `process` template ships an edge-scoped probabilistic policy:
// when a calling Action `serves` a child purpose Intent (a sub-process), the
// Intent's name must be the base (imperative) form of the third-person Action
// (`Posts a job` → `Post a job`). Unlike a node policy, this fires on EDGE
// creation and the judge sees BOTH endpoints.
//
// What runs for real:
//   - the template definition + host seam that seeds the edge policy into the
//     `policies` table (against in-process PGlite loaded with the real schema),
//   - the web edge runner (`runEdgeAuthoringPolicies`) loading + matching that
//     policy and resolving it through the judge boundary.
// Only the LLM judge is stubbed (it can't run offline).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
const judge = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});
vi.mock("../llm-judge.server", () => ({ judgeProbabilisticPredicate: judge.run }));

import { createDocoInWorkspace } from "@doco/host";
import { runEdgeAuthoringPolicies } from "../authoring-runner.server";

const WORKSPACE_ID = "workspace_01EDGEPOL000000000000001";
const USER_ID = "user_01EDGEPOL0000000000000001";

let docoId = "";

// With `role` gone, the edge is scoped by edge_type + endpoint node types only.
const servesEdge = {
  edge_type: "supports",
  from_node_type: "action",
  to_node_type: "intent",
} as const;

/** The combined judge payload the edge runner is handed (built by captureEdge). */
function pairing(actionText: string, intentText: string): Record<string, unknown> {
  return {
    id: "action_x->intent_y",
    edge_type: "supports",
    action: { name: null, text: actionText },
    intent: { name: null, text: intentText },
  };
}

beforeAll(async () => {
  dbm.db = new PGlite();
  await dbm.db.exec(schemaSql);
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'edge-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name, data) VALUES ($1,'edge-test','Edge Test','{}')",
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

describe("edge-scoped sub-process naming policy — end-to-end via runEdgeAuthoringPolicies", () => {
  it("seeds the edge policy and hands the judge BOTH endpoints", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: servesEdge,
      judgeCandidate: pairing("Posts a job", "Post a job"),
    });
    expect(judge.run).toHaveBeenCalledTimes(1);
    const [spec, candidate] = judge.run.mock.calls[0];
    // The spec is the seeded sub-process naming instruction…
    expect(spec).toMatch(/base \(imperative\) verb form|base form/i);
    // …and the judge sees both the Action and the Intent text.
    expect(candidate).toMatchObject({
      action: { text: "Posts a job" },
      intent: { text: "Post a job" },
    });
    expect(result.blocking).toBeNull();
  });

  it("BLOCKS when the judge rejects a third-person Intent name", async () => {
    judge.run.mockResolvedValue({
      ok: false,
      reason: "intent name is not the base form of the action",
    });
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: servesEdge,
      judgeCandidate: pairing("Posts a job", "Posts a job"),
    });
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.kind).toBe("probabilistic");
    expect(result.blocking?.on_violation).toBe("block");
    expect(result.blocking?.reason).toMatch(/base form of the action/i);
  });

  it("does NOT fire on an ordinary flow-step serves edge from a non-Action (decision → intent)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { ...servesEdge, from_node_type: "decision" },
      judgeCandidate: pairing("Is the score above threshold?", "Approve a consumer loan"),
    });
    // from_node_type scoping excludes gateway Decisions — the judge isn't even called.
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it("does NOT fire on a `supports` edge to a non-Intent endpoint (action → rule)", async () => {
    // With `role` gone, endpoint node types are the only scoping beyond
    // edge_type. A `supports` edge whose `to` endpoint is not an Intent (what an
    // Eval's `tests` edge used to be) doesn't match the sub-process naming rule.
    judge.run.mockResolvedValue({ ok: true });
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { ...servesEdge, to_node_type: "rule" },
      judgeCandidate: pairing("Posts a job", "Posts a job"),
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.violations).toEqual([]);
  });
});

describe("edge-type allowlist (requires_edge_type) — end-to-end via runEdgeAuthoringPolicies", () => {
  // The process template seeds an edge-type allowlist:
  // flows_to / supports / attributed_to / constrained_by / replaces / derived_from.
  // It's deterministic (no judge) and a structural gate, so it blocks a
  // disallowed edge type at creation — even for a `drafting` edge.
  it("blocks an edge type not in the allowlist (has_parent), without calling the judge", async () => {
    const result = await runEdgeAuthoringPolicies({
      docoId,
      edge: { edge_type: "has_parent", from_node_type: "intent", to_node_type: "intent" },
      judgeCandidate: { id: "intent_a->intent_b", edge_type: "has_parent" },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_edge_type");
    expect(result.blocking?.on_violation).toBe("block");
    expect(result.blocking?.reason).toMatch(/has_parent/);
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
      edge: { edge_type: "relates_to", from_node_type: "intent", to_node_type: "intent" },
      judgeCandidate: { id: "intent_a->intent_b", edge_type: "relates_to" },
      includeProbabilistic: false,
    });
    expect(result.blocking?.sub_kind).toBe("requires_edge_type");
  });
});
