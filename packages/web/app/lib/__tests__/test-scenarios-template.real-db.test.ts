// Real-life exercise of the `test-scenarios` Doco template against the REAL
// authoring stack — the template definition (`@doco/host`
// DEFAULT_DOCO_TEMPLATES), the host seam that seeds a Doco's `policies` from it
// (`createDocoInWorkspace`, against in-process PGlite loaded with the real
// schema.sql), and the pure authoring evaluator (`@doco/shared`), driven
// exactly as `authoring-runner.server` drives it. The only stubbed boundary is
// the LLM judge (Suite E), which can't run offline.
//
// The template is the product here: it must be the best abstraction for
// documenting test scenarios for websites and apps AND logging what happened
// every time they ran, around one split — a SCENARIO is an Eval (the durable
// spec: preconditions, steps, expected result) and a RUN is a Log (one
// execution: environment, outcome, evidence). Five real-world test areas form
// the corpus (Suite A): if the template false-positives on a well-formed
// scenario or run, that is a defect. Suites B–E then prove it catches real
// modeling mistakes, implements the drafting exemption, guards the edge-type
// allowlist, and wires the checks end-to-end.

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

const WORKSPACE_ID = "workspace_01TESTSCEN0000000000000001";
const USER_ID = "user_01TESTSCEN00000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'qa-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'qa-test', 'QA')", [
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
    requestedHandle: "qa",
    createdByUserId: USER_ID,
    templateHandle: "test-scenarios",
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
    if (/belongs in a test Doco/i.test(s)) out.add("membership");
    else if (/single observable, checkable expected result/i.test(s)) out.add("scenario-quality");
    else if (/browser and version/i.test(s)) out.add("result-quality");
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

interface RunSpec {
  prose: string;
  outcome: "succeeded" | "failed";
  /** Evidence artifact (screenshot / recording / log) attached via `supports`. */
  evidence?: { label: string; locator: string };
  /** External defect ticket linked via `relates_to`. */
  defect?: { label: string; locator: string };
}
interface ScenarioSpec {
  prose: string;
  how_to_run: string;
  expected: string;
  kind?: string;
  runs: RunSpec[];
}
interface AreaSpec {
  key: string;
  /** The objective / suite the scenarios serve (Intent). */
  objective: string;
  /** The test owner (Principal). */
  owner: string;
  /** The requirement / acceptance criterion the scenarios trace to (Reference). */
  requirement?: { label: string; locator: string };
  scenarios: ScenarioSpec[];
}

interface BuiltArea extends Graph {
  objective: CandidateFields;
  owner: CandidateFields;
  scenarios: CandidateFields[];
  runs: CandidateFields[];
}

/** Materialize a test area: objective Intent + owner Principal + scenario Evals
 *  + run Logs + requirement/evidence/defect References and their edges. */
function buildArea(s: AreaSpec, lifecycle: Lifecycle): BuiltArea {
  const objective = node("intent", s.key, { intent: s.objective, priority: "p1" }, lifecycle);
  const owner = node("principal", s.key, { name: s.owner }, lifecycle);
  const nodes: CandidateFields[] = [objective, owner];
  const edges: EngineEdge[] = [];

  const requirement = s.requirement
    ? node(
        "reference",
        s.key,
        { reference: s.requirement.label, locator: s.requirement.locator },
        lifecycle,
      )
    : null;
  if (requirement) nodes.push(requirement);

  const scenarios: CandidateFields[] = [];
  const runs: CandidateFields[] = [];
  for (const sc of s.scenarios) {
    const ev = node(
      "eval",
      s.key,
      {
        eval: sc.prose,
        how_to_run: sc.how_to_run,
        expected: sc.expected,
        expected_status: "pass",
        criterion: { kind: "llm-judge" },
        ...(sc.kind ? { kind: sc.kind } : {}),
      },
      lifecycle,
    );
    nodes.push(ev);
    scenarios.push(ev);
    // A scenario traces to what it verifies, and names its owner.
    edges.push(edge(ev.id, (requirement ?? objective).id, "supports"));
    edges.push(edge(ev.id, owner.id, "attributed_to"));

    for (const run of sc.runs) {
      const lg = node(
        "log",
        s.key,
        { log: run.prose, verb: "ran", happened_at: "2026-06-06T10:00:00Z", outcome: run.outcome },
        lifecycle,
      );
      nodes.push(lg);
      runs.push(lg);
      // A run supports the scenario it executed, and names who ran it.
      edges.push(edge(lg.id, ev.id, "supports"));
      edges.push(edge(lg.id, owner.id, "attributed_to"));
      if (run.evidence) {
        const art = node(
          "reference",
          s.key,
          { reference: run.evidence.label, locator: run.evidence.locator },
          lifecycle,
        );
        nodes.push(art);
        edges.push(edge(art.id, lg.id, "supports"));
      }
      if (run.defect) {
        const bug = node(
          "reference",
          s.key,
          { reference: run.defect.label, locator: run.defect.locator },
          lifecycle,
        );
        nodes.push(bug);
        edges.push(edge(lg.id, bug.id, "relates_to"));
      }
    }
  }

  return { nodes, edges, principalIds: [owner.id], objective, owner, scenarios, runs };
}

// ─── the five real-life test areas ─────────────────────────────────────────────

const SCENARIOS: AreaSpec[] = [
  {
    key: "checkout",
    objective: "Guests and signed-in shoppers can complete checkout on every supported browser.",
    owner: "Checkout QA",
    requirement: {
      label: "Acceptance criteria: complete a purchase",
      locator: "https://example.com/specs/checkout#acceptance",
    },
    scenarios: [
      {
        prose: "A guest can complete a purchase with a valid credit card.",
        how_to_run:
          "Preconditions: a product is in stock. Steps: 1) add the product to the cart; 2) open the cart and click Checkout; 3) enter a valid test card (4242 4242 4242 4242) and a shipping address; 4) place the order.",
        expected:
          "An order-confirmation page with an order number is shown and a confirmation email is queued.",
        runs: [
          {
            prose:
              "Chrome 126 / macOS 14 / build 2026.6.1 on https://staging.example.com — order confirmed.",
            outcome: "succeeded",
          },
          {
            prose:
              "Safari 17 / iOS 17 / build 2026.6.1 on https://staging.example.com — the Place Order button did nothing; no confirmation shown.",
            outcome: "failed",
            evidence: {
              label: "Screen recording of the stuck Place Order button",
              locator: "https://example.com/evidence/checkout-safari.mp4",
            },
            defect: {
              label: "BUG-4821: Place Order is a no-op on Safari/iOS",
              locator: "https://github.com/acme/shop/issues/4821",
            },
          },
        ],
      },
      {
        prose: "Checkout rejects an expired card with a clear, field-level error.",
        how_to_run:
          "Steps: 1) reach the payment step with an item in the cart; 2) enter a card with a past expiry date; 3) submit.",
        expected:
          "The order is not placed and an inline error 'Your card has expired' appears under the expiry field.",
        runs: [
          {
            prose:
              "Firefox 127 / Windows 11 / build 2026.6.1 on https://staging.example.com — error shown, order not placed.",
            outcome: "succeeded",
          },
        ],
      },
    ],
  },
  {
    key: "auth",
    objective: "Users can sign in securely, and repeated failures are rate-limited.",
    owner: "Identity QA",
    scenarios: [
      {
        prose: "A registered user can sign in with valid credentials.",
        how_to_run:
          "Steps: 1) open /login; 2) enter a registered email and the correct password; 3) submit.",
        expected: "The user lands on /dashboard and the session cookie is set.",
        runs: [
          {
            prose:
              "Chrome 126 / Android 14 (Pixel 8) / build 1.9.0 on https://app.example.com — signed in, dashboard shown.",
            outcome: "succeeded",
          },
        ],
      },
      {
        prose: "The login form locks out after five consecutive failed attempts.",
        how_to_run:
          "Steps: 1) open /login; 2) submit a wrong password five times in a row for the same account.",
        expected:
          "After the fifth attempt the form is disabled for 60 seconds and a 'Too many attempts' message is shown.",
        runs: [
          {
            prose:
              "Chrome 126 / macOS 14 / build 1.9.0 on https://staging.example.com — locked out after the 5th attempt.",
            outcome: "succeeded",
          },
        ],
      },
    ],
  },
  {
    key: "onboarding",
    objective: "A new user completes first-run onboarding in the mobile app.",
    owner: "Mobile QA",
    scenarios: [
      {
        prose: "A first-time user finishes the three-step onboarding and reaches the home screen.",
        how_to_run:
          "Preconditions: a fresh install, no saved account. Steps: 1) launch the app; 2) grant notification permission; 3) pick a topic; 4) tap Done.",
        expected: "The home feed is shown and onboarding does not appear again on the next launch.",
        kind: "integration",
        runs: [
          {
            prose:
              "iOS 17 / iPhone 15 / build 4.2.0 (TestFlight) — onboarding completed, home feed shown.",
            outcome: "succeeded",
          },
          {
            prose:
              "Android 14 / Pixel 7 / build 4.2.0 (internal track) — onboarding completed, home feed shown.",
            outcome: "succeeded",
          },
        ],
      },
    ],
  },
  {
    key: "orders-api",
    objective: "The public Orders API returns the documented response shape.",
    owner: "Platform QA",
    requirement: {
      label: "OpenAPI schema for GET /api/v1/orders",
      locator: "https://example.com/openapi.yaml#/paths/~1orders",
    },
    scenarios: [
      {
        prose:
          "GET /api/v1/orders returns a 200 with a paginated list matching the documented schema.",
        how_to_run:
          "Run: `curl -sS -H 'Authorization: Bearer $TOKEN' https://api.example.com/api/v1/orders` and validate the body against the OpenAPI schema.",
        expected:
          "HTTP 200; body has `data` (array of orders) and `next_cursor` (string|null) per the schema.",
        kind: "integration",
        runs: [
          {
            prose:
              "build api-2026.06.06 against https://api.example.com — 200, body validated against the schema.",
            outcome: "succeeded",
          },
        ],
      },
    ],
  },
  {
    key: "a11y",
    objective: "The checkout form is operable by keyboard and screen reader (WCAG 2.2 AA).",
    owner: "Accessibility QA",
    requirement: {
      label: "WCAG 2.2 AA — 2.1.1 Keyboard, 4.1.2 Name/Role/Value",
      locator: "https://www.w3.org/TR/WCAG22/",
    },
    scenarios: [
      {
        prose:
          "Every checkout field is reachable and operable by keyboard alone, with a visible focus ring.",
        how_to_run:
          "Steps: 1) load the checkout page; 2) Tab through every control; 3) complete the form using only the keyboard; 4) run an axe-core scan.",
        expected:
          "All controls are reachable in a logical order, focus is always visible, and axe reports no serious or critical violations.",
        runs: [
          {
            prose:
              "Chrome 126 + VoiceOver / macOS 14 / build 2026.6.1 — keyboard order correct; axe found 1 serious contrast issue.",
            outcome: "failed",
            evidence: {
              label: "axe-core report (1 serious)",
              locator: "https://example.com/evidence/axe-checkout.html",
            },
            defect: {
              label: "A11Y-310: Insufficient contrast on the discount field label",
              locator: "https://github.com/acme/shop/issues/310",
            },
          },
        ],
      },
    ],
  },
];

// ─── Suite A: no false positives on five well-formed test areas ───────────────

describe("test-scenarios template — five real-life test areas (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, requires_field(how_to_run),
    // requires_edge(supports) → deterministic; membership + scenario/result
    // quality → probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(5);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node passes the deterministic gates with no block or warn`, () => {
      const g = buildArea(s, "active");
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

  it("queues exactly the right probabilistic checks per node type (checkout)", () => {
    const g = buildArea(SCENARIOS[0], "active");
    // A committed scenario gets the soft membership gate AND the scenario-quality judge.
    expect(probabilisticLabels(evaluate(g.scenarios[0], g))).toEqual(
      new Set(["membership", "scenario-quality"]),
    );
    // A committed run gets membership AND the result-quality judge.
    expect(probabilisticLabels(evaluate(g.runs[0], g))).toEqual(
      new Set(["membership", "result-quality"]),
    );
    // The objective Intent gets membership only.
    expect(probabilisticLabels(evaluate(g.objective, g))).toEqual(new Set(["membership"]));
    // The owner Principal is exempt from all of them (they are an actor, not content).
    expect(probabilisticLabels(evaluate(g.owner, g))).toEqual(new Set());
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("test-scenarios template — blocks malformed nodes", () => {
  it("blocks a committed scenario with no `how_to_run` (the completeness floor)", () => {
    const g = buildArea(SCENARIOS[0], "active");
    const bare = node("eval", "checkout", { eval: "Coupon codes apply a discount." }, "active");
    g.nodes.push(bare);
    g.edges.push(edge(bare.id, g.objective.id, "supports"));
    const blocks = deterministicBlocks(evaluate(bare, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_field");
    expect(blocks.some((b) => /how_to_run/.test(b.reason))).toBe(true);
  });

  it("blocks node types outside the allowlist (action, decision, state, rule, idea)", () => {
    const g = buildArea(SCENARIOS[0], "active");
    for (const t of ["action", "decision", "state", "rule", "idea"]) {
      const stray = node(t, "checkout", { [t]: "stray content", how_to_run: "x" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("warns (does not block) when a committed scenario has no `supports` edge (traceability)", () => {
    const g = buildArea(SCENARIOS[0], "active");
    const orphan = node(
      "eval",
      "checkout",
      {
        eval: "Search returns relevant products.",
        how_to_run: "Search for 'shoe' and inspect results.",
      },
      "active",
    );
    g.nodes.push(orphan); // no supports edge wired
    const vs = evaluate(orphan, g);
    expect(deterministicBlocks(vs)).toEqual([]);
    expect(deterministicWarns(vs).some((w) => w.sub_kind === "requires_edge")).toBe(true);
  });

  it("warns when a committed run has no `supports` edge to a scenario (orphan result)", () => {
    const g = buildArea(SCENARIOS[0], "active");
    const orphanRun = node(
      "log",
      "checkout",
      { log: "Ran something, it passed.", verb: "ran" },
      "active",
    );
    g.nodes.push(orphanRun); // no supports edge wired
    const vs = evaluate(orphanRun, g);
    expect(deterministicBlocks(vs)).toEqual([]);
    expect(deterministicWarns(vs).some((w) => w.sub_kind === "requires_edge")).toBe(true);
  });

  it("admits an owner Principal (no block, no warn)", () => {
    const g = buildArea(SCENARIOS[0], "active");
    const owner = node("principal", "checkout", { name: "Release QA" }, "active");
    const vs = evaluate(owner, g);
    expect(deterministicBlocks(vs)).toEqual([]);
    expect(deterministicWarns(vs)).toEqual([]);
  });
});

// ─── Suite C: the completeness floor is committed-only; drafting is exempt ─────

describe("test-scenarios template — `how_to_run` required only once committed", () => {
  function bareScenarioAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildArea(SCENARIOS[1], lifecycle);
    const bare = node("eval", "auth", { eval: "Password reset emails a link." }, lifecycle);
    g.nodes.push(bare);
    g.edges.push(edge(bare.id, g.objective.id, "supports"));
    return { candidate: bare, graph: g };
  }
  const missingSteps = (b: Violation) =>
    b.sub_kind === "requires_field" && /how_to_run/.test(b.reason);

  it("a drafting scenario may be a bare idea (no steps required)", () => {
    const { candidate, graph } = bareScenarioAt("drafting");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingSteps)).toBe(false);
  });

  it("a queued scenario must say how to run it", () => {
    const { candidate, graph } = bareScenarioAt("queued");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingSteps)).toBe(true);
  });

  it("an active scenario must say how to run it", () => {
    const { candidate, graph } = bareScenarioAt("active");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingSteps)).toBe(true);
  });

  it("a retired scenario is not re-judged for completeness", () => {
    const { candidate, graph } = bareScenarioAt("retired");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingSteps)).toBe(false);
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("test-scenarios template — edge-type allowlist", () => {
  const evalEdge = (edge_type: string): Violation[] =>
    evaluateEdgePolicies({
      edge: { edge_type } as EdgeCandidate,
      policies,
      includeProbabilistic: false,
    });
  const barred = (vs: Violation[]) =>
    vs.some((v) => v.sub_kind === "requires_edge_type" && v.on_violation === "block");

  for (const allowed of [
    "supports",
    "attributed_to",
    "has_parent",
    "relates_to",
    "replaces",
    "derived_from",
  ]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  for (const denied of ["flows_to", "constrained_by"]) {
    it(`bars \`${denied}\``, () => {
      expect(barred(evalEdge(denied))).toBe(true);
    });
  }
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("test-scenarios template — end-to-end via runAuthoringPolicies", () => {
  it("blocks an Action via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "action_tse2e-0",
        node_type: "action",
        doco_id: docoId,
        action: "Click the button.",
        verb: "click",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed scenario with no `how_to_run` (requires_field)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_tse2e-1",
        node_type: "eval",
        doco_id: docoId,
        eval: "Coupon codes apply a discount.",
        lifecycle: "active",
      },
    });
    expect(result.blocking?.sub_kind).toBe("requires_field");
  });

  it("passes a well-formed active scenario (the remaining gates are advisory warns)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_tse2e-2",
        node_type: "eval",
        doco_id: docoId,
        eval: "A guest can complete checkout with a valid card.",
        how_to_run: "Add an item, check out, pay with 4242 4242 4242 4242, place the order.",
        expected: "An order confirmation with an order number is shown.",
        lifecycle: "active",
      },
    });
    // No how_to_run block. The traceability supports-edge gate and the
    // probabilistic gates are warns, so the write is never hard-blocked.
    expect(result.blocking).toBeNull();
    expect(result.violations.every((v) => v.on_violation === "warn")).toBe(true);
  });

  it("does not hard-block a scenario even when the judge rejects (the soft gates are warns)", async () => {
    judge.run.mockResolvedValue({ ok: false, reason: "reads as several checks bundled together" });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_tse2e-3",
        node_type: "eval",
        doco_id: docoId,
        eval: "Test the whole site.",
        how_to_run: "Click around everywhere and see if anything breaks.",
        lifecycle: "active",
      },
    });
    expect(result.blocking).toBeNull();
    expect(
      result.violations.some((v) => v.kind === "probabilistic" && v.on_violation === "warn"),
    ).toBe(true);
  });
});
