// Exploratory scenario sweep for the `org-chart` template AND the org-tree
// perspective wiring — 10 realistic scenarios each, against the REAL stack
// (PGlite + real schema + real host seeding + real authoring evaluator + the
// real loader/layout). The goal is to surface issues on lifelike org charts,
// not just unit-sized fixtures.

import {
  type CandidateFields,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  type Violation,
  evaluateEdgePolicies,
  evaluatePolicies,
} from "@doco/shared";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { layoutOrgTree } from "../org-tree-layout";
import { type OrgTreeNode, loadOrgTreeData } from "../org-tree-perspective.server";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});

import { createDocoInWorkspace } from "@doco/host";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";

const WORKSPACE_ID = "workspace_01OCSCEN000000000000000001";
const USER_ID = "user_01OCSCEN0000000000000000001";
let docoId = "";
let policies: LoadedPolicy[] = [];

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
    if (data.kind !== "deterministic" && data.kind !== "probabilistic") continue;
    out.push({
      policy_id: row.id,
      kind: data.kind as LoadedPolicy["kind"],
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
  dbm.db = await freshDb();
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'oc-scen','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'oc-scen','OC Scen')", [
    WORKSPACE_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
    [WORKSPACE_ID, USER_ID],
  );
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "acme",
    createdByUserId: USER_ID,
    templateHandle: "org-chart",
  });
  docoId = created.docoId;
  policies = await loadSeededPolicies(docoId);
});

// ─── Part A harness: the authoring evaluator ──────────────────────────────────

let seq = 0;
function n(type: string, fields: Record<string, unknown>): CandidateFields {
  seq += 1;
  return {
    id: `${type}_n-${seq}`,
    node_type: type as CandidateFields["node_type"],
    doco_id: docoId,
    lifecycle: "active",
    ...fields,
  };
}
const e = (from: string, to: string, edge_type: string): EngineEdge => ({
  from_id: from,
  to_id: to,
  edge_type,
});

function evalNode(candidate: CandidateFields, edges: EngineEdge[]): Violation[] {
  return evaluatePolicies({
    candidate,
    policies,
    candidateEdges: edges.filter((x) => x.from_id === candidate.id),
    edges,
    principals: new Set(edges.flatMap((x) => [x.from_id, x.to_id])),
    population: [],
  });
}
const detBlocks = (vs: Violation[]) =>
  vs.filter((v) => v.kind === "deterministic" && v.on_violation === "block");
const subKinds = (vs: Violation[]) => detBlocks(vs).map((v) => v.sub_kind);
const edgeBlocked = (edge_type: string) =>
  evaluateEdgePolicies({ edge: { edge_type }, policies }).some(
    (v) => v.kind === "deterministic" && v.sub_kind === "requires_edge_type",
  );

/** Run a whole scenario graph: returns deterministic block sub_kinds per node + barred edge types. */
function runChart(nodes: CandidateFields[], edges: EngineEdge[]) {
  const nodeBlocks: Record<string, string[]> = {};
  for (const node of nodes) {
    const b = subKinds(evalNode(node, edges)).filter(Boolean) as string[];
    if (b.length) nodeBlocks[node.id] = b;
  }
  const edgeTypes = [...new Set(edges.map((x) => x.edge_type))];
  const barredEdges = edgeTypes.filter(edgeBlocked);
  return { nodeBlocks, barredEdges };
}

// ─── Part A: 10 realistic org-chart authoring scenarios ───────────────────────

describe("org-chart template — 10 realistic authoring scenarios", () => {
  it("S1 · clean startup tree (CEO → C-suite → VPs) passes with no hard blocks", () => {
    const ceo = n("principal", {
      prose: "CEO — Person, founder; top of chain (reports to the board)",
      kind: "human",
    });
    const cto = n("principal", { prose: "CTO — Person", kind: "human" });
    const cfo = n("principal", { prose: "CFO — Person", kind: "human" });
    const vpEng = n("principal", { prose: "VP Engineering — Person", kind: "human" });
    const vpSales = n("principal", { prose: "VP Sales — Person", kind: "human" });
    const nodes = [ceo, cto, cfo, vpEng, vpSales];
    const edges = [
      e(cto.id, ceo.id, "has_parent"),
      e(cfo.id, ceo.id, "has_parent"),
      e(vpEng.id, cto.id, "has_parent"),
      e(vpSales.id, ceo.id, "has_parent"),
    ];
    const { nodeBlocks, barredEdges } = runChart(nodes, edges);
    expect(nodeBlocks).toEqual({});
    expect(barredEdges).toEqual([]);
  });

  it("S2 · support org with AI agents (kind=agent) passes", () => {
    const lead = n("principal", { prose: "Support Lead — Person", kind: "human" });
    const triage = n("principal", {
      prose: "Triage Agent — routes inbound tickets",
      kind: "agent",
    });
    const escal = n("principal", {
      prose: "Escalation Agent — drafts L2 responses",
      kind: "agent",
    });
    const nodes = [lead, triage, escal];
    const edges = [e(triage.id, lead.id, "has_parent"), e(escal.id, lead.id, "has_parent")];
    expect(runChart(nodes, edges).nodeBlocks).toEqual({});
  });

  it("S3 · vacant exec seat (open req) passes", () => {
    const ceo = n("principal", { prose: "CEO — Person", kind: "human" });
    const cro = n("principal", { prose: "Chief Revenue Officer — Vacant, open req for Q3 start" });
    expect(runChart([ceo, cro], [e(cro.id, ceo.id, "has_parent")]).nodeBlocks).toEqual({});
  });

  it("S4 · matrix / dotted-line (one solid manager + relates_to) passes", () => {
    const country = n("principal", { prose: "Country Manager, France — Person", kind: "human" });
    const globalMkt = n("principal", { prose: "Global Head of Marketing — Person", kind: "human" });
    const mm = n("principal", { prose: "Marketing Manager, France — Person", kind: "human" });
    const edges = [
      e(mm.id, country.id, "has_parent"), // solid primary line
      e(mm.id, globalMkt.id, "relates_to"), // dotted-line coordination
    ];
    const { nodeBlocks, barredEdges } = runChart([country, globalMkt, mm], edges);
    expect(nodeBlocks).toEqual({}); // single has_parent → no unity-of-command block
    expect(barredEdges).toEqual([]); // relates_to is allowed
  });

  it("S5 · dual solid report (two has_parent) is BLOCKED by unity of command", () => {
    const engMgr = n("principal", { prose: "Engineering Manager — Person", kind: "human" });
    const analyticsMgr = n("principal", { prose: "Analytics Manager — Person", kind: "human" });
    const dataEng = n("principal", { prose: "Data Engineer — Person", kind: "human" });
    const edges = [
      e(dataEng.id, engMgr.id, "has_parent"),
      e(dataEng.id, analyticsMgr.id, "has_parent"),
    ];
    const { nodeBlocks } = runChart([engMgr, analyticsMgr, dataEng], edges);
    expect(nodeBlocks[dataEng.id]).toContain("limits_edge");
  });

  it("S6 · departments as Intent with attributed_to membership pass", () => {
    const team = n("intent", { prose: "Platform Team — owns shared infrastructure" });
    const lead = n("principal", { prose: "Platform Lead — Person", kind: "human" });
    const eng1 = n("principal", { prose: "Senior Engineer — Person", kind: "human" });
    const eng2 = n("principal", { prose: "Engineer — Person", kind: "human" });
    const edges = [
      e(lead.id, team.id, "attributed_to"),
      e(eng1.id, team.id, "attributed_to"),
      e(eng2.id, team.id, "attributed_to"),
      e(eng1.id, lead.id, "has_parent"),
      e(eng2.id, lead.id, "has_parent"),
    ];
    const { nodeBlocks, barredEdges } = runChart([team, lead, eng1, eng2], edges);
    expect(nodeBlocks).toEqual({});
    expect(barredEdges).toEqual([]);
  });

  it("S7 · decision authority (single accountable seat) passes", () => {
    const vpEng = n("principal", { prose: "VP Engineering — Person", kind: "human" });
    const dec = n("decision", {
      prose: "Approve cloud spend over $25k",
      decision: "VP Engineering is accountable; escalates to CFO above $100k",
    });
    const edges = [e(dec.id, vpEng.id, "attributed_to")];
    const { nodeBlocks, barredEdges } = runChart([vpEng, dec], edges);
    expect(nodeBlocks).toEqual({});
    expect(barredEdges).toEqual([]);
  });

  it("S8 · a process step (Action) is BLOCKED by the node-type allowlist", () => {
    const action = n("action", {
      prose: "Run weekly payroll",
      action: "Run weekly payroll",
      verb: "run",
    });
    expect(subKinds(evalNode(action, []))).toContain("requires_node_type");
  });

  it("S9 · a process-flow edge (flows_to) between seats is BLOCKED by the edge-type allowlist", () => {
    expect(edgeBlocked("flows_to")).toBe(true);
    expect(edgeBlocked("constrained_by")).toBe(true);
    // sanity: the org-chart edges are NOT barred
    for (const t of [
      "has_parent",
      "attributed_to",
      "relates_to",
      "supports",
      "replaces",
      "derived_from",
    ]) {
      expect(edgeBlocked(t)).toBe(false);
    }
  });

  it("S10 · job-description Reference + governance Rule pass alongside their seat", () => {
    const head = n("principal", { prose: "Head of Engineering — Person", kind: "human" });
    const jd = n("reference", {
      prose: "JD: Head of Engineering — responsibilities and decision rights",
      reference: "https://intranet/jd/head-eng",
    });
    const rule = n("rule", {
      prose: "Span of control should not exceed 8 direct reports",
      rule: "Span of control ≤ 8",
    });
    const edges = [e(jd.id, head.id, "supports")];
    const { nodeBlocks, barredEdges } = runChart([head, jd, rule], edges);
    expect(nodeBlocks).toEqual({});
    expect(barredEdges).toEqual([]);
  });
});

// ─── Part B harness: the org-tree perspective loader + layout ─────────────────

let pseq = 0;
async function clearGraph(): Promise<void> {
  await dbm.db.query("DELETE FROM edges WHERE doco_id = $1", [docoId]);
  await dbm.db.query("DELETE FROM nodes WHERE doco_id = $1", [docoId]);
}
async function principal(
  prose: string,
  opts: { kind?: string; lifecycle?: string; tsOffsetSec?: number } = {},
): Promise<string> {
  pseq += 1;
  const id = `principal_p${pseq}`;
  const ts = `now() + (interval '1 second' * ${opts.tsOffsetSec ?? pseq})`;
  await dbm.db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, kind, created_at)
     VALUES ($1,$2,'principal',$3,$4,$5, ${ts})`,
    [id, docoId, opts.lifecycle ?? "active", prose, opts.kind ?? null],
  );
  return id;
}
async function refNode(prose: string): Promise<string> {
  pseq += 1;
  const id = `reference_r${pseq}`;
  await dbm.db.query(
    "INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES ($1,$2,'reference','active',$3)",
    [id, docoId, prose],
  );
  return id;
}
let eseq = 0;
async function relEdge(
  from: string,
  to: string,
  edge_type: string,
  opts: { lifecycle?: string; tsOffsetSec?: number } = {},
): Promise<void> {
  eseq += 1;
  const fromType = from.split("_")[0];
  const toType = to.split("_")[0];
  const ts = `now() + (interval '1 second' * ${opts.tsOffsetSec ?? eseq})`;
  await dbm.db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, lifecycle, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ${ts})`,
    [`edge_e${eseq}`, docoId, edge_type, from, fromType, to, toType, opts.lifecycle ?? "active"],
  );
}
const byId = (data: { nodes: OrgTreeNode[] }, id: string) => data.nodes.find((x) => x.id === id);

describe("org-tree perspective — 10 realistic rendering scenarios", () => {
  it("P0 · realistic vacancy phrasings all infer `vacant` (prose-only occupant state)", async () => {
    // Vacancy is the one occupant state with NO structured `kind` fallback, so
    // the prose scan must cover how authors actually mark an open seat.
    await clearGraph();
    const vacantProse = [
      "Staff Engineer — Vacant, open req for a Q3 start",
      "TBH — Senior PM (to be hired)",
      "Open headcount — Data Scientist",
      "Backfill: Staff Designer",
      "Senior SRE — req open, hiring now",
      "Account Executive — currently unstaffed, no incumbent",
      "Requisition open: Security Engineer",
      "Chief Revenue Officer — position unfilled",
    ];
    const ids: string[] = [];
    for (const p of vacantProse) ids.push(await principal(p));
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    for (const id of ids) {
      const nd = byId(data, id);
      expect(nd?.type, `expected vacant for: ${nd?.name}`).toBe("vacant");
    }
  });

  it("P0b · filled seats are NOT falsely read as vacant", async () => {
    // Guard the broadened vacancy scan against false positives on filled seats
    // whose prose merely mentions hiring/budget/headcount responsibilities.
    // `kind` is left UNSET so the prose inference actually runs (a set `kind`
    // would override it). A filled seat must not infer `vacant`.
    await clearGraph();
    const filled = [
      "VP People — owns hiring and headcount planning across the org",
      "Recruiter — runs the open-roles pipeline end to end",
      "Finance Director — manages the budgeted but un-forecast spend",
    ];
    const ids: string[] = [];
    for (const p of filled) ids.push(await principal(p));
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    for (const id of ids) {
      const nd = byId(data, id);
      expect(nd?.type, `should NOT be vacant: ${nd?.name}`).not.toBe("vacant");
    }
  });

  it("P1 · three-level reporting chain resolves reports_to + lays out by depth", async () => {
    await clearGraph();
    const ceo = await principal("CEO — Person", { kind: "human" });
    const cto = await principal("CTO — Person", { kind: "human" });
    const lead = await principal("Eng Lead — Person", { kind: "human" });
    const eng = await principal("Engineer — Person", { kind: "human" });
    await relEdge(cto, ceo, "has_parent");
    await relEdge(lead, cto, "has_parent");
    await relEdge(eng, lead, "has_parent");
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, cto)?.reports_to).toBe(ceo);
    expect(byId(data, lead)?.reports_to).toBe(cto);
    expect(byId(data, eng)?.reports_to).toBe(lead);
    expect(byId(data, ceo)?.reports_to).toBeNull();
    const layout = layoutOrgTree(data.nodes, null);
    const y = (id: string) => layout.nodes.find((nn) => nn.id === id)?.position.y ?? -1;
    expect(y(ceo)).toBeLessThan(y(cto));
    expect(y(cto)).toBeLessThan(y(lead));
    expect(layout.edges.filter((x) => !x.dotted)).toHaveLength(3);
  });

  it("P2 · two co-founders (no manager) render as two roots", async () => {
    await clearGraph();
    const a = await principal("Co-CEO (Product) — Person", { kind: "human" });
    const b = await principal("Co-CEO (Engineering) — Person", { kind: "human" });
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, a)?.reports_to).toBeNull();
    expect(byId(data, b)?.reports_to).toBeNull();
    const layout = layoutOrgTree(data.nodes, null);
    expect(layout.nodes).toHaveLength(2);
  });

  it("P3 · person vs agent icon comes from the kind column", async () => {
    await clearGraph();
    const human = await principal("Head of Support", { kind: "human" });
    const agent = await principal("Resolver Bot", { kind: "agent" });
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, human)?.type).toBe("person");
    expect(byId(data, agent)?.type).toBe("agent");
  });

  it("P4 · vacant seat is inferred from prose", async () => {
    await clearGraph();
    const seat = await principal("Staff Engineer — Vacant, open req for a Q3 start");
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, seat)?.type).toBe("vacant");
  });

  it("P5 · dotted-line (matrix) report from a relates_to between two seats", async () => {
    await clearGraph();
    const country = await principal("Country Manager, France — Person", { kind: "human" });
    const globalMkt = await principal("Global Head of Marketing — Person", { kind: "human" });
    const mm = await principal("Marketing Manager, France — Person", { kind: "human" });
    await relEdge(mm, country, "has_parent");
    await relEdge(mm, globalMkt, "relates_to");
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, mm)?.reports_to).toBe(country);
    expect(byId(data, mm)?.dotted_reports_to).toEqual([{ id: globalMkt, lifecycle: "active" }]);
    const layout = layoutOrgTree(data.nodes, null);
    const dashed = layout.edges.filter((x) => x.dotted);
    expect(dashed).toHaveLength(1);
    expect(dashed[0]).toMatchObject({ source: globalMkt, target: mm });
  });

  it("P6 · relates_to to a non-principal (a Reference) is NOT a dotted line", async () => {
    await clearGraph();
    const mm = await principal("Marketing Manager — Person", { kind: "human" });
    const charter = await refNode("Team charter: Marketing");
    await relEdge(mm, charter, "relates_to");
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, mm)?.dotted_reports_to).toEqual([]);
  });

  it("P7 · a relates_to that duplicates the solid line is dropped", async () => {
    await clearGraph();
    const boss = await principal("Director — Person", { kind: "human" });
    const report = await principal("Manager — Person", { kind: "human" });
    await relEdge(report, boss, "has_parent");
    await relEdge(report, boss, "relates_to");
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, report)?.reports_to).toBe(boss);
    expect(byId(data, report)?.dotted_reports_to).toEqual([]);
  });

  it("P8 · two has_parent edges resolve to a single (first) solid manager", async () => {
    await clearGraph();
    const a = await principal("Manager A — Person", { kind: "human" });
    const b = await principal("Manager B — Person", { kind: "human" });
    const rep = await principal("Engineer — Person", { kind: "human" });
    await relEdge(rep, a, "has_parent", { tsOffsetSec: 1 }); // earlier → primary
    await relEdge(rep, b, "has_parent", { tsOffsetSec: 2 });
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, rep)?.reports_to).toBe(a);
    const layout = layoutOrgTree(data.nodes, null);
    // The tree draws exactly one solid edge for the report (no double parent).
    expect(layout.edges.filter((x) => !x.dotted && x.target === rep)).toHaveLength(1);
  });

  it("P9 · a retired seat keeps its reporting line resolved", async () => {
    await clearGraph();
    const boss = await principal("VP — Person", { kind: "human" });
    const gone = await principal("Former Lead — Person", { kind: "human", lifecycle: "retired" });
    await relEdge(gone, boss, "has_parent", { lifecycle: "retired" });
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, gone)?.reports_to).toBe(boss);
    expect(byId(data, gone)?.lifecycle).toBe("retired");
  });

  it("P11 · a re-pointed seat follows its ACTIVE line, not the retired old one", async () => {
    // Re-pointing a reporting line retires the old `has_parent` edge (created
    // first) and adds a new active one (edges are immutable). Both seats stay
    // active, so toggling "Retired" off doesn't hide either manager — the tree
    // must place the seat under the LIVE manager. Regression for the org-tree
    // bug where "first parent wins" followed the older, retired edge and the
    // seat rendered under its FORMER manager.
    await clearGraph();
    const oldBoss = await principal("Alex — CEO", { kind: "human" });
    const newBoss = await principal("Juanfer — Head of Growth", { kind: "human" });
    const seat = await principal("Daniel — Head of Crawling", { kind: "human" });
    await relEdge(seat, oldBoss, "has_parent", { lifecycle: "retired", tsOffsetSec: 1 });
    await relEdge(seat, newBoss, "has_parent", { lifecycle: "active", tsOffsetSec: 2 });
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    expect(byId(data, seat)?.reports_to).toBe(newBoss);
    const layout = layoutOrgTree(data.nodes, null);
    const solidIntoSeat = layout.edges.filter((x) => !x.dotted && x.target === seat);
    expect(solidIntoSeat).toHaveLength(1);
    expect(solidIntoSeat[0]?.source).toBe(newBoss);
  });

  it("P10 · a 12-seat company with one matrix link lays out fully", async () => {
    await clearGraph();
    const ceo = await principal("CEO — Person", { kind: "human" });
    const cto = await principal("CTO — Person", { kind: "human" });
    const cfo = await principal("CFO — Person", { kind: "human" });
    const cro = await principal("CRO — Vacant, open req"); // vacant exec
    const eng1 = await principal("Eng Manager — Person", { kind: "human" });
    const eng2 = await principal("Staff Engineer — Person", { kind: "human" });
    const eng3 = await principal("Build Bot", { kind: "agent" });
    const fin1 = await principal("Controller — Person", { kind: "human" });
    const sales1 = await principal("Sales Manager — Person", { kind: "human" });
    const sales2 = await principal("AE — Person", { kind: "human" });
    const mkt1 = await principal("Marketing Lead — Person", { kind: "human" });
    const data1 = await principal("Data Analyst — Person", { kind: "human" });
    for (const [c, p] of [
      [cto, ceo],
      [cfo, ceo],
      [cro, ceo],
      [eng1, cto],
      [eng2, eng1],
      [eng3, eng1],
      [fin1, cfo],
      [sales1, cro],
      [sales2, sales1],
      [mkt1, cro],
      [data1, cto],
    ] as const) {
      await relEdge(c, p, "has_parent");
    }
    // Data Analyst dotted-lines to the CFO (analytics serves finance).
    await relEdge(data1, cfo, "relates_to");
    const data = await loadOrgTreeData(dbm.db, docoId, "acme");
    const total = Object.values(data.totalByLifecycle).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(12);
    expect(data.nodes).toHaveLength(12);
    expect(byId(data, cro)?.type).toBe("vacant");
    expect(byId(data, eng3)?.type).toBe("agent");
    expect(byId(data, data1)?.dotted_reports_to).toEqual([{ id: cfo, lifecycle: "active" }]);
    const layout = layoutOrgTree(data.nodes, null);
    expect(layout.nodes).toHaveLength(12); // everyone placed
    expect(layout.edges.filter((x) => !x.dotted)).toHaveLength(11); // 12 seats, 1 root
    expect(layout.edges.filter((x) => x.dotted)).toHaveLength(1);
  });
});
