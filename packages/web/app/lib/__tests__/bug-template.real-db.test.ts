// Real-life exercise of the `bugs` Doco template against the REAL authoring
// stack — the template definition (`@doco/host` DEFAULT_DOCO_TEMPLATES), the
// host seam that seeds a Doco's `policies` from it (`createDocoInWorkspace`,
// against in-process PGlite loaded with the real schema.sql), and the pure
// authoring evaluator (`@doco/shared`), driven exactly as
// `authoring-runner.server` drives it. The only stubbed boundary is the LLM
// judge (Suite E), which can't run offline.
//
// The template is the product here: it claims that a bug IS a failing Eval —
// the irreducible core of any bug (a reproducible discrepancy between
// `expected` and `actual`) is the Eval's native shape, and the bug + its
// regression test are one node seen at two moments (red when reported, green
// when fixed). Six real-world bugs across domains form the corpus (Suite A): if
// the template false-positives on a well-formed report, that is a defect. Suites
// B–E then prove it catches real modeling mistakes, implements the drafting
// exemption and the committed-only gating, guards the edge-type allowlist, and
// wires the whole thing end-to-end through the real runner.

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
import { runAuthoringPolicies } from "../authoring-runner.server";

const WORKSPACE_ID = "workspace_01BUGTEST000000000000001";
const USER_ID = "user_01BUGTEST0000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'bug-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'bug-test', 'Bugs')", [
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
  dbm.db = await freshDb();
  await seedWorkspaceAndUser();
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "tracker",
    createdByUserId: USER_ID,
    templateHandle: "bugs",
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
    if (/belongs in a bug tracker/i.test(s)) out.add("membership");
    else if (/could reproduce the defect/i.test(s)) out.add("report-quality");
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

interface BugSpec {
  key: string;
  owner: string;
  summary: string;
  expected: string;
  actual: string;
  how_to_run: string;
  severity: string;
  priority: string;
  /** Extra domain fields stashed in the node (e.g. cve/cvss for a security bug). */
  extra?: Record<string, unknown>;
  /** Reference locators that `supports` the bug (evidence + the fix). */
  evidence?: string[];
  /** How many occurrence Logs `supports` the bug. */
  occurrences?: number;
  /** A Rule (behavior contract / invariant) the bug `constrained_by`. */
  violates?: string;
}

interface BuiltBug extends Graph {
  owner: CandidateFields;
  bug: CandidateFields;
}

/** Materialize one bug (owner Principal + bug Eval + optional evidence/occurrences/contract + edges). */
function buildBug(s: BugSpec, lifecycle: Lifecycle): BuiltBug {
  const owner = node("principal", s.key, { name: s.owner }, lifecycle);
  const bug = node(
    "eval",
    s.key,
    {
      prose: s.summary,
      expected: s.expected,
      actual: s.actual,
      how_to_run: s.how_to_run,
      severity: s.severity,
      priority: s.priority,
      ...(s.extra ?? {}),
    },
    lifecycle,
  );
  const nodes: CandidateFields[] = [owner, bug];
  const edges: EngineEdge[] = [edge(bug.id, owner.id, "attributed_to")];
  for (const locator of s.evidence ?? []) {
    const ref = node("reference", s.key, { prose: locator, locator }, lifecycle);
    nodes.push(ref);
    edges.push(edge(ref.id, bug.id, "supports"));
  }
  for (let i = 0; i < (s.occurrences ?? 0); i += 1) {
    const log = node(
      "log",
      s.key,
      { prose: `occurrence ${i + 1}`, verb: "observed", happened_at: "2026-06-01T00:00:00Z" },
      lifecycle,
    );
    nodes.push(log);
    edges.push(edge(log.id, bug.id, "supports"));
  }
  if (s.violates) {
    const rule = node("rule", s.key, { prose: s.violates }, lifecycle);
    nodes.push(rule);
    edges.push(edge(bug.id, rule.id, "constrained_by"));
  }
  return { nodes, edges, principalIds: [owner.id], owner, bug };
}

// ─── the six real-life bugs (across domains) ──────────────────────────────────

const SCENARIOS: BugSpec[] = [
  {
    // The canonical Mozilla bug-writing example.
    key: "desktop",
    owner: "File Manager Owner",
    summary: "Cancelling a file-copy dialog crashes the file manager",
    expected:
      "Clicking Cancel stops the copy, closes the dialog, and leaves the file manager running.",
    actual:
      "The file manager crashes to the desktop with no error message; the partial copy is left behind.",
    how_to_run:
      "1. Start copying a folder larger than 1 GB. 2. While the progress bar is moving, click Cancel.",
    severity: "critical",
    priority: "p1",
    evidence: ["crash-id://bp-7f3a92e1"],
    occurrences: 3,
  },
  {
    key: "api",
    owner: "Platform On-Call",
    summary: "GET /orders returns 500 when the cursor parameter is empty",
    expected:
      "An empty `cursor` is treated as the first page and returns 200 with the first 50 orders.",
    actual:
      "The endpoint returns HTTP 500 with `TypeError: cannot read property 'id' of undefined`.",
    how_to_run:
      "1. Call `GET /orders?cursor=`. 2. Observe the 500 response and the stack trace in the logs.",
    severity: "major",
    priority: "p1",
    evidence: ["https://logs.example.com/trace/abc123"],
  },
  {
    key: "data",
    owner: "Data Platform Owner",
    summary: "Nightly revenue rollup double-counts refunded orders",
    expected:
      "The `daily_revenue` rollup reports revenue net of refunds (refunds subtracted once).",
    actual:
      "Refunded orders are added as positive revenue, so 2026-05-30 reports $48,210 vs the true $41,905.",
    how_to_run:
      "1. Run the `daily_revenue` job for 2026-05-30. 2. Compare its total against the ledger sum net of refunds.",
    severity: "major",
    priority: "p0",
    violates: "Reported revenue is always net of refunds for the period.",
  },
  {
    key: "security",
    owner: "Security Engineering",
    summary: "Reflected XSS in the product search box",
    expected:
      "User-supplied search text is HTML-escaped before it is echoed back into the results page.",
    actual:
      "A query like `<script>alert(1)</script>` executes in the victim's browser when the link is opened.",
    how_to_run:
      "1. Open `/search?q=<script>alert(1)</script>`. 2. Observe the script executing in the rendered page.",
    severity: "critical",
    priority: "p0",
    extra: { cve: "CVE-2026-12345", cvss: "8.2", cwe: "CWE-79", affected_versions: "<= 4.7.2" },
    violates: "All user-supplied input is escaped before being rendered (CWE-79).",
  },
  {
    key: "mobile",
    owner: "Mobile Owner",
    summary: "App crashes on launch on Android 14 after the 4.8 upgrade",
    expected: "The app launches to the home screen on a fresh Android 14 install.",
    actual:
      "The app crashes during the splash screen ~30% of cold starts with an `IllegalStateException`.",
    how_to_run:
      "1. Install 4.8 on a Pixel 8 (Android 14). 2. Cold-start the app repeatedly; it crashes intermittently.",
    severity: "critical",
    priority: "p1",
    extra: {
      reproducibility: "intermittent (~30% of cold starts)",
      environment: "Android 14, app 4.8.0",
    },
    occurrences: 5,
  },
  {
    key: "perf",
    owner: "Web Performance Owner",
    summary: "Dashboard p95 load time regressed from 0.8 s to 4.2 s",
    expected: "The dashboard's p95 first-contentful-paint stays under 1 second, as it did on 4.7.",
    actual:
      "Since 4.8 the p95 FCP is 4.2 s; the overview query now runs unbatched, once per widget.",
    how_to_run:
      "1. Load `/dashboard` on a cold cache. 2. Measure p95 FCP over 20 loads and compare against the 4.7 baseline.",
    severity: "major",
    priority: "p1",
    extra: { metric: "p95 FCP", baseline: "0.8s", regressed_to: "4.2s" },
    evidence: ["https://profiles.example.com/dashboard-4.8"],
  },
];

// ─── Suite A: no false positives on six well-formed bugs ──────────────────────

describe("bug template — six real-life bugs (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, requires_field(core),
    // requires_field(severity/priority, warn), requires_edge(owner) →
    // deterministic; membership + report-quality → probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(5);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node passes the deterministic gates with no block or warn`, () => {
      const g = buildBug(s, "active");
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

  it("queues exactly the right probabilistic checks per node type (the security bug)", () => {
    const g = buildBug(SCENARIOS[3], "active");
    // A committed bug gets both the soft membership gate and the report-quality
    // judge.
    expect(probabilisticLabels(evaluate(g.bug, g))).toEqual(
      new Set(["membership", "report-quality"]),
    );
    // The owner Principal is exempt from both (they are eval-scoped).
    expect(probabilisticLabels(evaluate(g.owner, g))).toEqual(new Set());
    // The violated-contract Rule is exempt too.
    const rule = g.nodes.find((n) => n.node_type === "rule");
    if (!rule) throw new Error("expected a violated-contract Rule");
    expect(probabilisticLabels(evaluate(rule, g))).toEqual(new Set());
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("bug template — blocks malformed bugs", () => {
  it("blocks a committed bug missing the irreducible core (expected/actual/steps)", () => {
    const g = buildBug(SCENARIOS[0], "active");
    // A bare bug record with an owner but no discrepancy + reproduction.
    const owner = node("principal", "desktop", { name: "Owner" }, "active");
    const bare = node("eval", "desktop", { prose: "something is broken" }, "active");
    g.nodes.push(owner, bare);
    g.edges.push(edge(bare.id, owner.id, "attributed_to"));
    const blocks = deterministicBlocks(evaluate(bare, g));
    const coreBlock = blocks.find((b) => b.sub_kind === "requires_field");
    expect(coreBlock, "a committed bug with no expected/actual/steps must block").toBeDefined();
    expect(coreBlock?.reason).toMatch(/expected/);
    expect(coreBlock?.reason).toMatch(/actual/);
    expect(coreBlock?.reason).toMatch(/how_to_run/);
  });

  it("blocks node types outside the allowlist (action, decision, state, intent, idea)", () => {
    const g = buildBug(SCENARIOS[0], "active");
    for (const t of ["action", "decision", "state", "intent", "idea"]) {
      const stray = node(t, "desktop", { [t]: "stray content" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits the supporting cast (Reference, Log, Rule) and the owner Principal", () => {
    const g = buildBug(SCENARIOS[0], "active");
    for (const t of ["reference", "log", "rule", "principal"]) {
      const ok = node(
        t,
        "desktop",
        { prose: "x", ...(t === "principal" ? { name: "x" } : {}) },
        "active",
      );
      expect(
        deterministicBlocks(evaluate(ok, g)).some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be admitted by the node-type allowlist`,
      ).toBe(false);
    }
  });

  it("requires exactly one accountable owner: blocks a committed bug with no `attributed_to` edge", () => {
    const g = buildBug(SCENARIOS[0], "active");
    const orphan = node(
      "eval",
      "desktop",
      {
        prose: "orphan bug",
        expected: "x works",
        actual: "x fails",
        how_to_run: "1. do x",
        severity: "major",
        priority: "p2",
      },
      "active",
    );
    g.nodes.push(orphan); // deliberately no attributed_to edge
    const blocks = deterministicBlocks(evaluate(orphan, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge")).toBe(true);
  });

  it("an owned committed bug clears the owner floor", () => {
    const g = buildBug(SCENARIOS[0], "active");
    // The corpus bug already carries its attributed_to edge.
    expect(
      deterministicBlocks(evaluate(g.bug, g)).some((b) => b.sub_kind === "requires_edge"),
    ).toBe(false);
  });
});

// ─── Suite B2: severity/priority is a WARN, not a block ───────────────────────

describe("bug template — severity/priority is strongly recommended (warn, not block)", () => {
  it("warns — but does NOT block — a committed bug that omits severity/priority", () => {
    const g = buildBug(SCENARIOS[1], "active");
    const owner = node("principal", "api", { name: "Owner" }, "active");
    const unrated = node(
      "eval",
      "api",
      {
        prose: "unrated but well-characterized bug",
        expected: "returns 200",
        actual: "returns 500",
        how_to_run: "1. call the endpoint with an empty cursor",
        // no severity, no priority
      },
      "active",
    );
    g.nodes.push(owner, unrated);
    g.edges.push(edge(unrated.id, owner.id, "attributed_to"));
    const vs = evaluate(unrated, g);
    const ratingWarn = deterministicWarns(vs).find(
      (w) => w.sub_kind === "requires_field" && /severity|priority/.test(w.reason),
    );
    expect(ratingWarn, "missing severity/priority should warn").toBeDefined();
    // …and it is only a warn — the core+owner are satisfied, so nothing blocks.
    expect(deterministicBlocks(vs)).toEqual([]);
  });
});

// ─── Suite C: completeness is committed-only; drafting & retired are exempt ────

describe("bug template — core + owner required only once committed", () => {
  function bareBugAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildBug(SCENARIOS[2], lifecycle);
    // A lone bug record: no core fields, no owner edge.
    const bare = node("eval", "data", { prose: "rollup looks off" }, lifecycle);
    g.nodes.push(bare);
    return { candidate: bare, graph: g };
  }
  const missingCore = (b: Violation) =>
    b.sub_kind === "requires_field" && /expected/.test(b.reason);
  const missingOwner = (b: Violation) => b.sub_kind === "requires_edge";

  it("a drafting report may be a bare description (no core, no owner required)", () => {
    const { candidate, graph } = bareBugAt("drafting");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingCore)).toBe(false);
    expect(blocks.some(missingOwner)).toBe(false);
  });

  it("a queued bug must carry the core and an owner", () => {
    const { candidate, graph } = bareBugAt("queued");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingCore)).toBe(true);
    expect(blocks.some(missingOwner)).toBe(true);
  });

  it("an active bug must carry the core and an owner", () => {
    const { candidate, graph } = bareBugAt("active");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingCore)).toBe(true);
    expect(blocks.some(missingOwner)).toBe(true);
  });

  it("a retired (closed) bug is not re-judged for completeness", () => {
    const { candidate, graph } = bareBugAt("retired");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingCore)).toBe(false);
    expect(blocks.some(missingOwner)).toBe(false);
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("bug template — edge-type allowlist", () => {
  const evalEdge = (edge_type: string): Violation[] =>
    evaluateEdgePolicies({
      edge: { edge_type } as EdgeCandidate,
      policies,
      includeProbabilistic: false,
    });
  const barred = (vs: Violation[]) =>
    vs.some((v) => v.sub_kind === "requires_edge_type" && v.on_violation === "block");

  for (const allowed of [
    "attributed_to",
    "supports",
    "constrained_by",
    "replaces",
    "derived_from",
    "relates_to",
  ]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  for (const denied of ["flows_to", "has_parent"]) {
    it(`bars \`${denied}\` (process flow / pool membership has no place in a bug tracker)`, () => {
      expect(barred(evalEdge(denied))).toBe(true);
    });
  }
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("bug template — end-to-end via runAuthoringPolicies", () => {
  it("blocks a Decision via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "decision_buge2e-0",
        node_type: "decision",
        doco_id: docoId,
        decision: "Pick a fix strategy.",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed bug missing the irreducible core (requires_field)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_buge2e-1",
        node_type: "eval",
        doco_id: docoId,
        prose: "it's broken",
        lifecycle: "active",
      },
    });
    expect(result.blocking).not.toBeNull();
    expect(
      result.violations.some(
        (v) =>
          v.sub_kind === "requires_field" &&
          v.on_violation === "block" &&
          /expected/.test(v.reason),
      ),
    ).toBe(true);
  });

  it("blocks a committed, well-characterized bug that has no owner (requires_edge attributed_to)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_buge2e-2",
        node_type: "eval",
        doco_id: docoId,
        prose: "ownerless bug",
        expected: "x works",
        actual: "x fails",
        how_to_run: "1. do x",
        severity: "major",
        priority: "p1",
        lifecycle: "active",
      },
    });
    // Core + rating satisfied, so the only block is the missing owner edge.
    expect(result.blocking?.sub_kind).toBe("requires_edge");
  });

  it("lets a raw drafting report flow (committed-only gating — a bare description is never blocked)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_buge2e-3",
        node_type: "eval",
        doco_id: docoId,
        prose: "Search sometimes returns stale results — needs triage.",
        lifecycle: "drafting",
      },
    });
    expect(result.blocking).toBeNull();
  });

  it("does not hard-block a bug even when the judge rejects (the soft gates are warns)", async () => {
    // The membership gate fires on every stage; a judge rejection surfaces a
    // warning but never blocks the write.
    judge.run.mockResolvedValue({
      ok: false,
      reason: "reads like a feature request, not a defect",
    });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_buge2e-4",
        node_type: "eval",
        doco_id: docoId,
        prose: "Please add a dark mode to the dashboard.",
        lifecycle: "drafting",
      },
    });
    expect(result.blocking).toBeNull();
    expect(
      result.violations.some((v) => v.kind === "probabilistic" && v.on_violation === "warn"),
    ).toBe(true);
  });
});
