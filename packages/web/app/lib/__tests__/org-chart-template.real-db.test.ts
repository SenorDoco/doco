// Real-life exercise of the `org-chart` Doco template against the REAL
// authoring stack.
//
// The template is the product here: it is meant to be the best abstraction for
// documenting an organization's STRUCTURE (seats, solid reporting lines, teams,
// dotted-line coordination, decision authority), and it must behave correctly
// under the current architecture — the unified `policies` table and the
// org-tree perspective it ships pre-attached.
//
// What runs for real:
//   - the template definition itself (`@doco/host` DEFAULT_DOCO_TEMPLATES),
//   - the host seam that seeds a Doco's `policies` rows AND its
//     `doco_perspectives` from it (`createDocoInWorkspace`, against an
//     in-process PGlite loaded with the real schema.sql), and
//   - the pure authoring evaluator (`@doco/shared` evaluatePolicies /
//     evaluateEdgePolicies), driven as `authoring-runner.server` drives it.
// No LLM judge is needed: the assertions cover only the deterministic gates and
// the perspective wiring; the template's probabilistic checks are all `warn`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CandidateFields,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  type Violation,
  evaluateEdgePolicies,
  evaluatePolicies,
} from "@doco/shared";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeAll, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});

import { createDocoInWorkspace } from "@doco/host";

const WORKSPACE_ID = "workspace_01OCRTEST0000000000000001";
const USER_ID = "user_01OCRTEST00000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'oc-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'oc-test','OC Test')", [
    WORKSPACE_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
    [WORKSPACE_ID, USER_ID],
  );
}

/** Load the Doco's enforceable policies in the same shape the runner uses. */
async function loadSeededPolicies(id: string): Promise<LoadedPolicy[]> {
  const r = await dbm.db.query<{ id: string; data: unknown }>(
    "SELECT id, data FROM policies WHERE doco_id = $1 AND COALESCE(lifecycle,'active') = 'active'",
    [id],
  );
  const out: LoadedPolicy[] = [];
  for (const row of r.rows) {
    const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Record<
      string,
      unknown
    >;
    const kind = data.kind;
    if (kind !== "deterministic" && kind !== "probabilistic") continue;
    out.push({
      policy_id: row.id,
      kind,
      predicate: data.predicate as LoadedPolicy["predicate"],
      ...(typeof data.on_violation === "string"
        ? { on_violation: data.on_violation as LoadedPolicy["on_violation"] }
        : {}),
      ...(Array.isArray(data.fires_when_node_lifecycle)
        ? { fires_when_node_lifecycle: data.fires_when_node_lifecycle as Lifecycle[] }
        : {}),
    });
  }
  return out;
}

beforeAll(async () => {
  dbm.db = new PGlite({ extensions: { vector } });
  await dbm.db.exec(schemaSql);
  await seedWorkspaceAndUser();
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "acme",
    createdByUserId: USER_ID,
    templateHandle: "org-chart",
  });
  docoId = created.docoId;
  policies = await loadSeededPolicies(docoId);
});

// ─── evaluation harness ──────────────────────────────────────────────────────

let seq = 0;
function nid(type: string): string {
  // Suffix uses a hyphen: entityTypeFromId() splits on the LAST `_`.
  seq += 1;
  return `${type}_seat-${seq}`;
}
function node(type: string, fields: Record<string, unknown>): CandidateFields {
  return {
    id: nid(type),
    node_type: type as CandidateFields["node_type"],
    doco_id: docoId,
    lifecycle: "active",
    ...fields,
  };
}
function edge(from: string, to: string, edge_type: string): EngineEdge {
  return { from_id: from, to_id: to, edge_type };
}

/** Evaluate one candidate against the seeded template policies, as the runner would. */
function evaluate(candidate: CandidateFields, edges: EngineEdge[]): Violation[] {
  return evaluatePolicies({
    candidate,
    policies,
    candidateEdges: edges.filter((e) => e.from_id === candidate.id),
    edges,
    principals: new Set(edges.flatMap((e) => [e.from_id, e.to_id])),
    population: [],
  });
}

const blocks = (vs: Violation[]) =>
  vs.filter((v) => v.kind === "deterministic" && v.on_violation === "block");

/** Edge-type allowlist violations for a candidate edge type. */
function edgeAllowlistViolations(edge_type: string): Violation[] {
  return evaluateEdgePolicies({ edge: { edge_type }, policies }).filter(
    (v) => v.kind === "deterministic" && v.sub_kind === "requires_edge_type",
  );
}

// ─── the template wires up at all ─────────────────────────────────────────────

describe("org-chart template — seeding", () => {
  it("seeds the expected deterministic gates and soft (warn) probabilistic checks", () => {
    const sub = (k: string) =>
      policies.some(
        (p) =>
          p.kind === "deterministic" && "sub_kind" in p.predicate && p.predicate.sub_kind === k,
      );
    expect(sub("requires_node_type")).toBe(true);
    expect(sub("requires_edge_type")).toBe(true);
    expect(sub("limits_edge")).toBe(true);
    // Both semantic gates are soft.
    const probWarns = policies.filter((p) => p.kind === "probabilistic");
    expect(probWarns.length).toBeGreaterThanOrEqual(2);
    expect(probWarns.every((p) => (p.on_violation ?? "block") === "warn")).toBe(true);
  });
});

// ─── connect the perspective to the template ───────────────────────────────────

describe("org-chart template — org-tree perspective is connected", () => {
  it("attaches the org-tree perspective as the new Doco's default tab", async () => {
    const r = await dbm.db.query<{ slug: string; is_default: boolean }>(
      `SELECT p.slug, dp.is_default
         FROM doco_perspectives dp
         JOIN perspectives p ON p.id = dp.perspective_id
        WHERE dp.doco_id = $1
        ORDER BY dp.position`,
      [docoId],
    );
    const slugs = r.rows.map((x) => x.slug);
    // The org-tree tab is present and is THE default.
    expect(slugs).toContain("org-tree");
    expect(r.rows.find((x) => x.slug === "org-tree")?.is_default).toBe(true);
    // Graph + list defaults stay attached behind it; exactly one tab is default.
    expect(slugs).toEqual(expect.arrayContaining(["graph", "list", "org-tree"]));
    expect(r.rows.filter((x) => x.is_default)).toHaveLength(1);
  });
});

// ─── deterministic gates fire correctly ────────────────────────────────────────

describe("org-chart template — node-type allowlist", () => {
  it("admits a seat (Principal) but blocks a process/work node (Action)", () => {
    const seat = node("principal", { name: "Head of Engineering" });
    const step = node("action", { action: "Approve the invoice" });
    expect(blocks(evaluate(seat, [])).some((v) => v.sub_kind === "requires_node_type")).toBe(false);
    expect(blocks(evaluate(step, [])).some((v) => v.sub_kind === "requires_node_type")).toBe(true);
  });
});

describe("org-chart template — edge-type allowlist", () => {
  it("admits reporting/association edges and bars process-flow edges", () => {
    for (const allowed of ["has_parent", "attributed_to", "relates_to", "supports"]) {
      expect(edgeAllowlistViolations(allowed)).toHaveLength(0);
    }
    const barred = edgeAllowlistViolations("flows_to");
    expect(barred).toHaveLength(1);
    expect(barred[0].on_violation).toBe("block");
    expect(edgeAllowlistViolations("constrained_by")).toHaveLength(1);
  });

  it("admits `relates_to` — the edge type that carries the dotted-line meaning", () => {
    // The org-tree loader reads a `relates_to` between two seats as a
    // dotted-line / matrix report, so the template must permit it.
    expect(edgeAllowlistViolations("relates_to")).toHaveLength(0);
  });
});

describe("org-chart template — unity of command", () => {
  it("blocks a seat with two `has_parent` managers, but allows exactly one", () => {
    const ceo = node("principal", { name: "CEO — top of chain" });
    const cto = node("principal", { name: "CTO" });
    const seat = node("principal", { name: "Staff Engineer" });
    const oneLine = [edge(seat.id, ceo.id, "has_parent")];
    const twoLines = [...oneLine, edge(seat.id, cto.id, "has_parent")];
    expect(blocks(evaluate(seat, oneLine)).some((v) => v.sub_kind === "limits_edge")).toBe(false);
    expect(blocks(evaluate(seat, twoLines)).some((v) => v.sub_kind === "limits_edge")).toBe(true);
  });
});

describe("org-chart template — a well-formed chart passes the hard gates", () => {
  it("does not deterministically block a seat reporting to its single manager", () => {
    const ceo = node("principal", { name: "CEO — Person, top of chain (reports to the board)" });
    const head = node("principal", { name: "Head of Engineering — Person" });
    const wiring = [edge(head.id, ceo.id, "has_parent")];
    expect(blocks(evaluate(head, wiring))).toHaveLength(0);
    expect(blocks(evaluate(ceo, wiring))).toHaveLength(0);
  });
});
