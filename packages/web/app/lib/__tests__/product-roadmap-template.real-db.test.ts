// Real-life exercise of the `product-roadmap` Doco template against the REAL
// authoring stack — the template definition (`@doco/host`
// DEFAULT_DOCO_TEMPLATES), the host seam that seeds a Doco's `policies` from it
// (`createDocoInWorkspace`, against in-process PGlite loaded with the real
// schema.sql), and the pure authoring evaluator (`@doco/shared`), driven
// exactly as `authoring-runner.server` drives it. The only stubbed boundary is
// the LLM judge (Suite E), which can't run offline.
//
// Six real-world roadmaps form the corpus (Suite A): if the template
// false-positives on a well-formed, outcome-framed bet, that is a defect.
// Suites B–E then prove it catches real modeling mistakes (off-roadmap node
// types, a committed item with no owner or no horizon, a dangling result),
// implements the drafting exemption, guards the edge-type allowlist, and wires
// the checks end-to-end through the runner. The `horizon` gate is the one that
// matters most to prove end-to-end: it reads a field that lives in the node's
// `extra` bag, so this test confirms the whole seed → flatten → evaluate path.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CandidateFields,
  type EdgeCandidate,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  type Violation,
  evaluateEdgePolicies,
  evaluatePolicies,
  isDeterministicPredicate,
} from "@doco/shared";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
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
import { runAuthoringPolicies } from "../authoring-runner.server";

const WORKSPACE_ID = "workspace_01ROADTEST00000000000001";
const USER_ID = "user_01ROADTEST000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'road-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'road-test', 'Road')", [
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
    requestedHandle: "roadmap",
    createdByUserId: USER_ID,
    templateHandle: "product-roadmap",
  });
  docoId = created.docoId;
  policies = await loadSeededPolicies(docoId);
});

beforeEach(() => {
  judge.run.mockReset();
});

// ─── evaluation harness (mirrors authoring-runner.server) ─────────────────────

const LIFECYCLE_INDEPENDENT = new Set([
  "requires_entity_type",
  "requires_node_type",
  "forbids_edge",
  "forbids_field",
]);

interface Graph {
  nodes: CandidateFields[];
  edges: EngineEdge[];
  principalIds: string[];
}

function evaluate(candidate: CandidateFields, graph: Graph): Violation[] {
  let applicable = policies;
  if (candidate.lifecycle === "retired") {
    applicable = policies.filter(
      (p) =>
        isDeterministicPredicate(p.predicate) && LIFECYCLE_INDEPENDENT.has(p.predicate.sub_kind),
    );
  }
  return evaluatePolicies({
    candidate,
    policies: applicable,
    candidateEdges: graph.edges.filter((e) => e.from_id === candidate.id),
    edges: graph.edges,
    principals: new Set(graph.principalIds),
    population: graph.nodes.filter((n) => n.id !== candidate.id),
  });
}

const deterministicBlocks = (vs: Violation[]) =>
  vs.filter((v) => v.kind === "deterministic" && v.on_violation === "block");
const deterministicWarns = (vs: Violation[]) =>
  vs.filter((v) => v.kind === "deterministic" && v.on_violation === "warn");

/** Classify a fired probabilistic check by a stable keyword in its spec. */
function probabilisticLabels(vs: Violation[]): Set<string> {
  const out = new Set<string>();
  for (const v of vs) {
    if (v.kind !== "probabilistic") continue;
    const s = v.pending_spec ?? v.reason;
    if (/belongs on a product roadmap/i.test(s)) out.add("membership");
    else if (/frames a desired OUTCOME/i.test(s)) out.add("outcome");
    else if (/closes the loop on its bet/i.test(s)) out.add("result-loop");
    else if (/single accountable owner/i.test(s)) out.add("owner-shape");
  }
  return out;
}

// ─── node / graph builders ────────────────────────────────────────────────────

let seq = 0;
function nid(type: string, key: string): string {
  seq += 1;
  return `${type}_${key}-${seq}`;
}
function node(
  type: string,
  key: string,
  fields: Record<string, unknown>,
  lifecycle: Lifecycle,
): CandidateFields {
  return {
    id: nid(type, key),
    node_type: type as CandidateFields["node_type"],
    doco_id: docoId,
    lifecycle,
    ...fields,
  };
}
function edge(from: string, to: string, edge_type: string): EngineEdge {
  return { from_id: from, to_id: to, edge_type };
}

type Horizon = "now" | "next" | "later";
interface ResultSpec {
  prose: string;
  expected: string;
  actual?: string;
  last_status: "pass" | "fail" | "pending";
}
interface ItemSpec {
  outcome: string;
  horizon: Horizon;
  priority?: "p0" | "p1" | "p2" | "p3";
  /** Index of another item this one is grouped under (has_parent → objective). */
  parent?: number;
  /** Index of another item this one depends on / coordinates with (relates_to). */
  related?: number;
  /** A measured result for this bet (Eval, `supports` the item). */
  result?: ResultSpec;
  /** Supporting discovery/evidence for this bet (Reference, `supports` the item). */
  evidence?: { label: string; locator: string };
}
interface RoadmapSpec {
  key: string;
  owner: { name: string };
  items: ItemSpec[];
}

interface BuiltRoadmap extends Graph {
  owner: CandidateFields;
  items: CandidateFields[];
  results: CandidateFields[];
  references: CandidateFields[];
}

/** Materialize a roadmap (owner Principal + item Intents + result Evals + evidence References + edges). */
function buildRoadmap(s: RoadmapSpec, lifecycle: Lifecycle): BuiltRoadmap {
  const owner = node("principal", s.key, { name: s.owner.name }, lifecycle);
  const items = s.items.map((it) =>
    node(
      "intent",
      s.key,
      {
        intent: it.outcome,
        horizon: it.horizon,
        ...(it.priority ? { priority: it.priority } : {}),
      },
      lifecycle,
    ),
  );
  const results: CandidateFields[] = [];
  const references: CandidateFields[] = [];
  const edges: EngineEdge[] = [];

  s.items.forEach((it, i) => {
    // Every item names the owner accountable for its outcome.
    edges.push(edge(items[i].id, owner.id, "attributed_to"));
    // Grouping under an objective, and dependencies between bets.
    if (it.parent != null) edges.push(edge(items[i].id, items[it.parent].id, "has_parent"));
    if (it.related != null) edges.push(edge(items[i].id, items[it.related].id, "relates_to"));
    // The result that closes the loop, linked to the item it measures.
    if (it.result) {
      const ev = node(
        "eval",
        s.key,
        {
          eval: it.result.prose,
          expected: it.result.expected,
          ...(it.result.actual ? { actual: it.result.actual } : {}),
          last_status: it.result.last_status,
        },
        lifecycle,
      );
      results.push(ev);
      edges.push(edge(ev.id, items[i].id, "supports"));
    }
    // Discovery / evidence behind the bet.
    if (it.evidence) {
      const ref = node(
        "reference",
        s.key,
        { reference: it.evidence.label, locator: it.evidence.locator },
        lifecycle,
      );
      references.push(ref);
      edges.push(edge(ref.id, items[i].id, "supports"));
    }
  });

  return {
    nodes: [owner, ...items, ...results, ...references],
    edges,
    principalIds: [owner.id],
    owner,
    items,
    results,
    references,
  };
}

// ─── the six real-life roadmaps ────────────────────────────────────────────────

const SCENARIOS: RoadmapSpec[] = [
  {
    key: "saas-activation",
    owner: { name: "Growth PM" },
    items: [
      {
        outcome:
          "Help newly signed-up teams reach their first shared win fast — raise week-one activation (a team that creates and shares one doc) from 22% to 40%.",
        horizon: "now",
        priority: "p0",
        result: {
          prose: "Week-one team activation after the guided-setup bet.",
          expected: "40% of new teams activate in week one",
          actual: "37% — short of target but a clear lift from 22%",
          last_status: "pass",
        },
        evidence: {
          label: "Onboarding interviews: teams stall before the first shared doc",
          locator: "https://research.example.com/onboarding-stall",
        },
      },
      {
        outcome:
          "Cut time-to-value for solo trials so more convert — get a first solo user to a published doc within 10 minutes of signup.",
        horizon: "next",
        priority: "p1",
        related: 0,
      },
      {
        outcome:
          "Make returning weekly a habit for activated teams — lift 4-week team retention, direction only for now.",
        horizon: "later",
        priority: "p2",
      },
    ],
  },
  {
    key: "fintech-trust",
    owner: { name: "Payments Lead" },
    items: [
      {
        outcome:
          "Reduce payment friction at checkout — cut the share of card payments that fail on first attempt from 8% to under 3%.",
        horizon: "now",
        priority: "p0",
        result: {
          prose: "First-attempt card success rate after the retry-and-routing bet.",
          expected: "first-attempt failures below 3%",
          actual: "2.6% — target met; persevere and roll out to all regions",
          last_status: "pass",
        },
      },
      {
        outcome:
          "Earn buyer trust in disputes — halve the time to resolve a chargeback so sellers stop churning over it.",
        horizon: "next",
        priority: "p1",
        evidence: {
          label: "Seller churn analysis: disputes cited in 30% of cancellations",
          locator: "doc://insights/seller-churn-2026",
        },
      },
    ],
  },
  {
    key: "devtools",
    owner: { name: "DX Lead" },
    items: [
      {
        outcome:
          "Get developers to a working integration sooner — raise the share who make a successful first API call within their first session from 45% to 70%.",
        horizon: "now",
        priority: "p0",
        result: {
          prose: "First-session successful-call rate after the quickstart + sandbox bet.",
          expected: "70% make a successful first call in session one",
          actual: "58% — moved the needle but missed; iterate on error messaging",
          last_status: "fail",
        },
      },
      {
        outcome:
          "Keep integrations healthy — reduce the rate of webhooks that silently fail so teams trust the platform.",
        horizon: "next",
        priority: "p2",
      },
    ],
  },
  {
    key: "marketplace",
    owner: { name: "Supply PM" },
    items: [
      {
        // An objective the two bets below roll up to.
        outcome:
          "Balance the marketplace so demand is always met — keep the share of searches that return at least three available providers above 90%.",
        horizon: "now",
        priority: "p0",
      },
      {
        outcome:
          "Bring on supply where it's thin — raise active providers in under-served metros by 25% to meet local demand.",
        horizon: "now",
        priority: "p1",
        parent: 0,
        result: {
          prose: "Active providers in the five thinnest metros after the onboarding-incentive bet.",
          expected: "+25% active providers in under-served metros",
          actual: "+19% so far; still measuring through the next cohort",
          last_status: "pending",
        },
      },
      {
        outcome:
          "Keep good providers active — lift 90-day provider retention so the supply we add actually sticks.",
        horizon: "next",
        priority: "p1",
        parent: 0,
      },
    ],
  },
  {
    key: "healthtech",
    owner: { name: "Clinical Product" },
    items: [
      {
        outcome:
          "Give clinicians back time — cut the median time to complete a discharge summary from 18 to under 10 minutes without losing required detail.",
        horizon: "now",
        priority: "p0",
        evidence: {
          label: "Time-and-motion study of discharge documentation",
          locator: "https://research.example.com/discharge-tam",
        },
        result: {
          prose: "Median discharge-summary completion time after the smart-template bet.",
          expected: "median under 10 minutes",
          actual: "11.5 minutes — close; iterate on the medication section",
          last_status: "fail",
        },
      },
      {
        outcome:
          "Reduce avoidable readmissions — raise the share of discharges with a confirmed follow-up booked within 7 days.",
        horizon: "later",
        priority: "p2",
      },
    ],
  },
  {
    key: "consumer-mobile",
    owner: { name: "Mobile PM" },
    items: [
      {
        outcome:
          "Hook new listeners in the first week — raise day-7 retention for first-time users from 18% to 28% by nailing the first session.",
        horizon: "now",
        priority: "p0",
        result: {
          prose: "Day-7 retention for the first-session-personalization cohort.",
          expected: "day-7 retention reaches 28%",
          actual: "29% — target beaten; persevere and expand personalization",
          last_status: "pass",
        },
      },
      {
        outcome:
          "Grow word-of-mouth — get more activated users to share a playlist, lifting invites sent per active user.",
        horizon: "next",
        priority: "p2",
        related: 0,
      },
    ],
  },
];

// ─── Suite A: no false positives on six well-formed roadmaps ──────────────────

describe("product-roadmap template — six real-life roadmaps (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, attributed_to owner,
    // requires_field(horizon), supports → deterministic; membership, outcome,
    // result-loop, owner-shape → probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(8);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node passes the deterministic gates with no block or warn`, () => {
      const g = buildRoadmap(s, "active");
      for (const candidate of g.nodes) {
        const vs = evaluate(candidate, g);
        const blocks = deterministicBlocks(vs);
        const warns = deterministicWarns(vs);
        expect(
          blocks,
          `${candidate.node_type} ${candidate.id} wrongly blocked: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
        ).toEqual([]);
        expect(
          warns,
          `${candidate.node_type} ${candidate.id} wrongly warned: ${warns.map((w) => `${w.sub_kind}: ${w.reason}`).join("; ")}`,
        ).toEqual([]);
      }
    });
  }

  it("queues exactly the right probabilistic checks per node type (saas-activation)", () => {
    const g = buildRoadmap(SCENARIOS[0], "active");
    // A committed item: the membership gate + the outcome-over-output judge.
    expect(probabilisticLabels(evaluate(g.items[0], g))).toEqual(
      new Set(["membership", "outcome"]),
    );
    // A committed result: the membership gate + the close-the-loop judge.
    expect(probabilisticLabels(evaluate(g.results[0], g))).toEqual(
      new Set(["membership", "result-loop"]),
    );
    // The owner Principal: only the owner-shape judge (exempt from membership).
    expect(probabilisticLabels(evaluate(g.owner, g))).toEqual(new Set(["owner-shape"]));
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("product-roadmap template — blocks malformed bets", () => {
  it("blocks a committed item that carries no `horizon` (the placement floor)", () => {
    const g = buildRoadmap(SCENARIOS[0], "active");
    const placeless = node("intent", "saas-activation", { intent: "raise activation" }, "active");
    g.nodes.push(placeless);
    g.edges.push(edge(placeless.id, g.owner.id, "attributed_to"));
    const blocks = deterministicBlocks(evaluate(placeless, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_field");
    expect(blocks.some((b) => /horizon/.test(b.reason))).toBe(true);
  });

  it("blocks a committed item with no accountable owner (the attribution floor)", () => {
    const g = buildRoadmap(SCENARIOS[0], "active");
    const ownerless = node(
      "intent",
      "saas-activation",
      { intent: "raise activation", horizon: "now" },
      "active",
    );
    g.nodes.push(ownerless);
    // No attributed_to edge for this one.
    const blocks = deterministicBlocks(evaluate(ownerless, g));
    expect(
      blocks.some((b) => b.sub_kind === "requires_edge" && /attributed_to/.test(b.reason)),
    ).toBe(true);
  });

  it("blocks a committed result that measures nothing (no `supports` edge)", () => {
    const g = buildRoadmap(SCENARIOS[0], "active");
    const dangling = node(
      "eval",
      "saas-activation",
      { eval: "some metric", expected: "x", last_status: "pending" },
      "active",
    );
    g.nodes.push(dangling);
    const blocks = deterministicBlocks(evaluate(dangling, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge" && /supports/.test(b.reason))).toBe(
      true,
    );
  });

  it("blocks node types outside the allowlist (action, state, log, idea)", () => {
    const g = buildRoadmap(SCENARIOS[0], "active");
    for (const t of ["action", "state", "log", "idea"]) {
      const stray = node(t, "saas-activation", { [t]: "stray content", horizon: "now" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits an owner Principal (no block)", () => {
    const g = buildRoadmap(SCENARIOS[0], "active");
    const owner = node("principal", "saas-activation", { name: "Retention PM" }, "active");
    expect(deterministicBlocks(evaluate(owner, g))).toEqual([]);
  });
});

// ─── Suite C: completeness floors are committed-only; drafting is exempt ───────

describe("product-roadmap template — owner & horizon required only once committed", () => {
  function bareItemAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildRoadmap(SCENARIOS[1], lifecycle);
    // A bare item: no horizon, no owner edge.
    const bare = node("intent", "fintech-trust", { intent: "reduce payment friction" }, lifecycle);
    g.nodes.push(bare);
    return { candidate: bare, graph: g };
  }
  const missingHorizon = (b: Violation) =>
    b.sub_kind === "requires_field" && /horizon/.test(b.reason);
  const missingOwner = (b: Violation) =>
    b.sub_kind === "requires_edge" && /attributed_to/.test(b.reason);

  it("a drafting (parked / Later) idea may lack both an owner and a horizon", () => {
    const { candidate, graph } = bareItemAt("drafting");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingHorizon)).toBe(false);
    expect(blocks.some(missingOwner)).toBe(false);
  });

  it("a queued (planned / Next) item must carry its owner and horizon", () => {
    const { candidate, graph } = bareItemAt("queued");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingHorizon)).toBe(true);
    expect(blocks.some(missingOwner)).toBe(true);
  });

  it("an active (in-progress / Now) item must carry its owner and horizon", () => {
    const { candidate, graph } = bareItemAt("active");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingHorizon)).toBe(true);
    expect(blocks.some(missingOwner)).toBe(true);
  });

  it("a retired (shipped & closed) item is not re-judged for completeness", () => {
    const { candidate, graph } = bareItemAt("retired");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingHorizon)).toBe(false);
    expect(blocks.some(missingOwner)).toBe(false);
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("product-roadmap template — edge-type allowlist", () => {
  const evalEdge = (edge_type: string): Violation[] =>
    evaluateEdgePolicies({
      edge: { edge_type } as EdgeCandidate,
      policies,
      includeProbabilistic: false,
    });
  const barred = (vs: Violation[]) =>
    vs.some((v) => v.sub_kind === "requires_edge_type" && v.on_violation === "block");

  for (const allowed of [
    "has_parent",
    "attributed_to",
    "supports",
    "constrained_by",
    "relates_to",
    "derived_from",
    "replaces",
  ]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  it("bars `flows_to` — process sequence flow has no place on a roadmap", () => {
    expect(barred(evalEdge("flows_to"))).toBe(true);
  });
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("product-roadmap template — end-to-end via runAuthoringPolicies", () => {
  it("blocks an Action via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "action_roade2e-0",
        node_type: "action",
        doco_id: docoId,
        action: "Build the onboarding checklist.",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed item missing its owner and horizon", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "intent_roade2e-1",
        node_type: "intent",
        doco_id: docoId,
        intent: "raise activation",
        lifecycle: "active",
      },
    });
    expect(result.violations.some((v) => v.sub_kind === "requires_field")).toBe(true);
    expect(result.violations.some((v) => v.sub_kind === "requires_edge")).toBe(true);
    expect(result.blocking).not.toBeNull();
  });

  it("does not block a drafting (parked) idea even with no owner or horizon", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "intent_roade2e-2",
        node_type: "intent",
        doco_id: docoId,
        intent: "explore a referral loop",
        lifecycle: "drafting",
      },
    });
    expect(result.blocking).toBeNull();
  });
});
