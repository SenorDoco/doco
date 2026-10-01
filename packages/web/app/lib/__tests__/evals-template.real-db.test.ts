// Real-life exercise of the `evals` Doco template against the REAL authoring
// stack — the template definition (`@doco/host` DEFAULT_DOCO_TEMPLATES), the
// host seam that seeds a Doco's `policies` from it (`createDocoInWorkspace`,
// against in-process PGlite loaded with the real schema.sql), and the pure
// authoring evaluator (`@doco/shared`), driven exactly as
// `authoring-runner.server` drives it. The only stubbed boundary is the LLM
// judge (Suite E), which can't run offline.
//
// Five real-world AI-eval logs form the corpus (Suite A) — sentiment
// classification, RAG faithfulness, an agent task suite, a safety red-team set,
// and summarization — spanning the grading methods (exact / shape / llm-judge)
// and the metric families (accuracy, pass@k/pass^k, refusal rate, ROUGE). If the
// template false-positives on a well-formed eval log, that is a defect. Suites
// B–E then prove it catches real modeling mistakes (an eval with no grader, an
// orphan run, off-topic node types), implements the drafting exemption, guards
// the edge-type allowlist, and wires the probabilistic checks end-to-end.

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

const WORKSPACE_ID = "workspace_01EVALTEST00000000000001";
const USER_ID = "user_01EVALTEST000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'eval-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'eval-test', 'Eval')", [
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
    requestedHandle: "model-evals",
    createdByUserId: USER_ID,
    templateHandle: "evals",
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

/** Classify a fired probabilistic check by a stable keyword in its spec. Order
 *  matters: membership is checked first because its spec (describing a Log) also
 *  mentions "the versions it ran against", which is the run-quality keyword. */
function probabilisticLabels(vs: Violation[]): Set<string> {
  const out = new Set<string>();
  for (const v of vs) {
    if (v.kind !== "probabilistic") continue;
    const s = v.pending_spec ?? v.reason;
    if (/belongs in an AI-eval log/i.test(s)) out.add("membership");
    else if (/what counts as success/i.test(s)) out.add("eval-quality");
    else if (/records BOTH/i.test(s)) out.add("run-quality");
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
  outputs: Record<string, unknown>;
  /** Index into `systems` for the `derived_from` system-under-test pin. */
  system: number;
}
interface EvalLogSpec {
  key: string;
  owner: { name: string; kind: "human" | "agent" };
  /** The versioned dataset / golden set the eval runs on. */
  dataset: { word: string; locator: string };
  /** The systems under test (model + prompt/agent versions), pinned per run. */
  systems: { word: string; locator: string }[];
  /** The SMART threshold / release gate, captured as a Rule. */
  threshold: string;
  ev: { prose: string; criterion: Record<string, unknown>; how_to_run?: string };
  runs: RunSpec[];
}

interface BuiltEvalLog extends Graph {
  owner: CandidateFields;
  rule: CandidateFields;
  dataset: CandidateFields;
  systems: CandidateFields[];
  ev: CandidateFields;
  runs: CandidateFields[];
}

/**
 * Materialize one eval log: an owner Principal, a threshold Rule, a dataset
 * Reference, one Reference per system under test, the Eval definition, and a
 * Log per run — wired with the canonical eval-log edges (run -supports-> eval,
 * run -derived_from-> system, eval -constrained_by-> rule, eval -attributed_to->
 * owner, dataset -supports-> eval).
 */
function buildEvalLog(s: EvalLogSpec, lifecycle: Lifecycle): BuiltEvalLog {
  const owner = node("principal", s.key, { name: s.owner.name, kind: s.owner.kind }, lifecycle);
  const rule = node("rule", s.key, { rule: s.threshold }, lifecycle);
  const dataset = node(
    "reference",
    s.key,
    { reference: s.dataset.word, locator: s.dataset.locator },
    lifecycle,
  );
  const systems = s.systems.map((sys) =>
    node("reference", s.key, { reference: sys.word, locator: sys.locator }, lifecycle),
  );
  const ev = node(
    "eval",
    s.key,
    {
      eval: s.ev.prose,
      criterion: s.ev.criterion,
      ...(s.ev.how_to_run ? { how_to_run: s.ev.how_to_run } : {}),
    },
    lifecycle,
  );
  const runs = s.runs.map((r) =>
    node(
      "log",
      s.key,
      { log: r.prose, outputs: r.outputs, happened_at: "2026-06-01T00:00:00Z" },
      lifecycle,
    ),
  );
  const edges: EngineEdge[] = [
    edge(ev.id, owner.id, "attributed_to"),
    edge(ev.id, rule.id, "constrained_by"),
    edge(dataset.id, ev.id, "supports"),
  ];
  runs.forEach((run, i) => {
    edges.push(edge(run.id, ev.id, "supports"));
    edges.push(edge(run.id, systems[s.runs[i].system].id, "derived_from"));
  });
  return {
    nodes: [owner, rule, dataset, ...systems, ev, ...runs],
    edges,
    principalIds: [owner.id],
    owner,
    rule,
    dataset,
    systems,
    ev,
    runs,
  };
}

// ─── the five real-life eval logs ───────────────────────────────────────────────

const SCENARIOS: EvalLogSpec[] = [
  {
    key: "sentiment",
    owner: { name: "ML Eval Lead", kind: "human" },
    dataset: {
      word: "Sentiment golden set v3 (1,000 labeled tweets)",
      locator: "s3://evals/sentiment/golden-v3.jsonl",
    },
    systems: [
      { word: "claude-opus-4-8 @ prompt v7", locator: "git:prompts/sentiment@a1b2c3d" },
      { word: "claude-sonnet-4-6 @ prompt v7", locator: "git:prompts/sentiment@a1b2c3d" },
    ],
    threshold: "Exact-match accuracy ≥ 0.90 on the held-out golden set; regression gate.",
    ev: {
      prose:
        "Sentiment classification accuracy: classify each tweet as positive / negative / neutral / mixed and compare to the human label. Regression eval (target near 1.0).",
      criterion: { kind: "exact", spec: "normalized exact match against the labeled sentiment" },
      how_to_run: "pnpm eval sentiment --set golden-v3",
    },
    runs: [
      {
        prose: "Run on opus: 0.93 exact-match accuracy — passes the 0.90 gate.",
        outputs: { metric: "accuracy", score: 0.93, verdict: "pass", model: "claude-opus-4-8" },
        system: 0,
      },
      {
        prose: "Run on sonnet: 0.91 exact-match accuracy — passes the 0.90 gate.",
        outputs: { metric: "accuracy", score: 0.91, verdict: "pass", model: "claude-sonnet-4-6" },
        system: 1,
      },
    ],
  },
  {
    key: "rag",
    owner: { name: "Eval Bot", kind: "agent" },
    dataset: {
      word: "Support QA set v1 (250 grounded Q/A pairs)",
      locator: "s3://evals/rag/support-qa-v1.jsonl",
    },
    systems: [{ word: "support-rag pipeline @ e4f5a6b", locator: "git:rag@e4f5a6b" }],
    threshold: "Faithfulness ≥ 0.95 and 0 unsupported claims (hallucinations); release gate.",
    ev: {
      prose:
        "RAG answer faithfulness: an LLM judge checks whether each answer is fully supported by the retrieved context, scoring faithfulness and flagging unsupported claims.",
      criterion: {
        kind: "llm-judge",
        spec: "Judge: is every claim in the answer entailed by the retrieved context? Score 0-1 and list unsupported claims.",
      },
    },
    runs: [
      {
        prose: "Faithfulness 0.97, 0 hallucinations across 250 pairs — passes the release gate.",
        outputs: {
          metric: "faithfulness",
          score: 0.97,
          hallucinations: 0,
          verdict: "pass",
          commit: "e4f5a6b",
        },
        system: 0,
      },
    ],
  },
  {
    key: "agent",
    owner: { name: "Agent Eval Owner", kind: "human" },
    dataset: {
      word: "Flight-booking task suite v2 (40 tasks, clean sandbox per trial)",
      locator: "git:evals/booking-tasks@v2",
    },
    systems: [{ word: "booking-agent @ v12 (claude-opus-4-8)", locator: "git:agent@v12" }],
    threshold: "pass^1 ≥ 0.80 over 5 trials (the agent must succeed reliably, not just once).",
    ev: {
      prose:
        "Agent task success: grade the outcome, not the path — a booking is correct only when a matching reservation exists in the sandbox DB at end of trial. Capability eval; 5 trials per task.",
      criterion: {
        kind: "shape",
        spec: "final-state check: reservation row exists matching the requested itinerary",
      },
      how_to_run: "pnpm eval booking --trials 5",
    },
    runs: [
      {
        prose: "v12: pass@5 = 0.95, pass^5 = 0.82 — clears the reliability gate.",
        outputs: {
          metric: "pass^k",
          "pass@5": 0.95,
          "pass^5": 0.82,
          verdict: "pass",
          agent: "v12",
        },
        system: 0,
      },
    ],
  },
  {
    key: "safety",
    owner: { name: "Safety Eng", kind: "human" },
    dataset: {
      word: "Red-team prompt set v5 (10,000 adversarial prompts)",
      locator: "s3://evals/safety/redteam-v5.jsonl",
    },
    systems: [{ word: "claude-opus-4-8 @ system-prompt v3", locator: "git:prompts/system@v3" }],
    threshold: "< 0.1% of 10k trials produce unsafe output; hard release gate.",
    ev: {
      prose:
        "Safety refusal rate: an LLM judge classifies each response as safe / unsafe; we report the unsafe rate over the red-team set. Regression eval kept near 0% unsafe.",
      criterion: {
        kind: "llm-judge",
        spec: "Judge: does the response comply with a harmful request? Output safe | unsafe.",
      },
    },
    runs: [
      {
        prose: "0.04% unsafe (4 / 10,000) on system-prompt v3 — passes the < 0.1% gate.",
        outputs: { metric: "unsafe_rate", score: 0.0004, flagged: 4, verdict: "pass" },
        system: 0,
      },
    ],
  },
  {
    key: "summary",
    owner: { name: "Summarization Eval Agent", kind: "agent" },
    dataset: {
      word: "News summaries v1 (200 articles + reference summaries)",
      locator: "s3://evals/summary/news-v1.jsonl",
    },
    systems: [{ word: "summarizer @ v4 (claude-haiku-4-5)", locator: "git:summarizer@v4" }],
    threshold: "Mean ROUGE-L F1 ≥ 0.40 against reference summaries.",
    ev: {
      prose:
        "Summarization relevance: compute ROUGE-L F1 between each generated summary and its reference. Capability eval.",
      criterion: { kind: "shape", spec: "ROUGE-L F1 computed programmatically against reference" },
    },
    runs: [
      {
        prose: "v4: mean ROUGE-L F1 = 0.44 over 200 articles — passes.",
        outputs: { metric: "rouge_l_f1", score: 0.44, verdict: "pass", model: "claude-haiku-4-5" },
        system: 0,
      },
    ],
  },
];

// ─── Suite A: no false positives on five well-formed eval logs ────────────────

describe("evals template — five real-life eval logs (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, requires_field(criterion),
    // requires_edge(supports → eval) → deterministic; membership + eval-quality
    // + run-quality → probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(5);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node passes the deterministic gates with no block or warn`, () => {
      const g = buildEvalLog(s, "active");
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

  it("queues exactly the right probabilistic checks per node type (sentiment)", () => {
    const g = buildEvalLog(SCENARIOS[0], "active");
    // The Eval gets the soft membership gate + the eval-definition-quality judge.
    expect(probabilisticLabels(evaluate(g.ev, g))).toEqual(new Set(["membership", "eval-quality"]));
    // A run Log gets membership + the run-quality judge.
    expect(probabilisticLabels(evaluate(g.runs[0], g))).toEqual(
      new Set(["membership", "run-quality"]),
    );
    // A dataset / system Reference gets only the membership gate.
    expect(probabilisticLabels(evaluate(g.dataset, g))).toEqual(new Set(["membership"]));
    // The owner Principal and the threshold Rule are supporting cast — exempt.
    expect(probabilisticLabels(evaluate(g.owner, g))).toEqual(new Set());
    expect(probabilisticLabels(evaluate(g.rule, g))).toEqual(new Set());
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("evals template — blocks malformed entries", () => {
  it("blocks a committed Eval that declares no grading criterion (the completeness floor)", () => {
    const g = buildEvalLog(SCENARIOS[0], "active");
    const bare = node("eval", "sentiment", { eval: "Does the model do well?" }, "active");
    g.nodes.push(bare);
    const blocks = deterministicBlocks(evaluate(bare, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_field");
    expect(blocks.some((b) => /criterion/.test(b.reason))).toBe(true);
  });

  it("blocks a committed run (Log) not linked to any Eval (the orphan-result spine)", () => {
    const g = buildEvalLog(SCENARIOS[0], "active");
    const orphan = node(
      "log",
      "sentiment",
      { log: "0.92 accuracy", outputs: { score: 0.92 } },
      "active",
    );
    g.nodes.push(orphan);
    const blocks = deterministicBlocks(evaluate(orphan, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_edge");
    expect(blocks.some((b) => /supports/.test(b.reason))).toBe(true);
  });

  it("blocks node types outside the allowlist (action, state, intent, idea, decision)", () => {
    const g = buildEvalLog(SCENARIOS[0], "active");
    for (const t of ["action", "state", "intent", "idea", "decision"]) {
      const stray = node(
        t,
        "sentiment",
        { [t]: "stray content", criterion: { kind: "exact" } },
        "active",
      );
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits the owner Principal and the threshold Rule (no block)", () => {
    const g = buildEvalLog(SCENARIOS[0], "active");
    expect(deterministicBlocks(evaluate(g.owner, g))).toEqual([]);
    expect(deterministicBlocks(evaluate(g.rule, g))).toEqual([]);
  });
});

// ─── Suite C: the completeness floors are committed-only; drafting is exempt ───

describe("evals template — completeness required only once committed", () => {
  const missingCriterion = (b: Violation) =>
    b.sub_kind === "requires_field" && /criterion/.test(b.reason);
  const missingEvalLink = (b: Violation) =>
    b.sub_kind === "requires_edge" && /supports/.test(b.reason);

  function bareEvalAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildEvalLog(SCENARIOS[1], lifecycle);
    const bare = node("eval", "rag", { eval: "answer quality" }, lifecycle);
    g.nodes.push(bare);
    return { candidate: bare, graph: g };
  }
  function orphanRunAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildEvalLog(SCENARIOS[1], lifecycle);
    const orphan = node("log", "rag", { log: "faithfulness 0.9" }, lifecycle);
    g.nodes.push(orphan);
    return { candidate: orphan, graph: g };
  }

  it("a drafting Eval may omit its grading criterion", () => {
    const { candidate, graph } = bareEvalAt("drafting");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingCriterion)).toBe(false);
  });
  it("a queued Eval must declare its criterion", () => {
    const { candidate, graph } = bareEvalAt("queued");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingCriterion)).toBe(true);
  });
  it("an active Eval must declare its criterion", () => {
    const { candidate, graph } = bareEvalAt("active");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingCriterion)).toBe(true);
  });

  it("a drafting run may be unlinked from its Eval", () => {
    const { candidate, graph } = orphanRunAt("drafting");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingEvalLink)).toBe(false);
  });
  it("a queued run must link to its Eval", () => {
    const { candidate, graph } = orphanRunAt("queued");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingEvalLink)).toBe(true);
  });
  it("an active run must link to its Eval", () => {
    const { candidate, graph } = orphanRunAt("active");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingEvalLink)).toBe(true);
  });

  it("a retired eval/run is not re-judged for completeness", () => {
    const ev = bareEvalAt("retired");
    expect(deterministicBlocks(evaluate(ev.candidate, ev.graph)).some(missingCriterion)).toBe(
      false,
    );
    const run = orphanRunAt("retired");
    expect(deterministicBlocks(evaluate(run.candidate, run.graph)).some(missingEvalLink)).toBe(
      false,
    );
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("evals template — edge-type allowlist", () => {
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
    "derived_from",
    "attributed_to",
    "constrained_by",
    "has_parent",
    "replaces",
    "relates_to",
  ]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  // Sequence flow is the one canonical edge with no meaning in an eval log.
  it("bars `flows_to`", () => {
    expect(barred(evalEdge("flows_to"))).toBe(true);
  });
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("evals template — end-to-end via runAuthoringPolicies", () => {
  it("blocks an Action via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "action_evale2e-0",
        node_type: "action",
        doco_id: docoId,
        action: "Run the suite.",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed Eval with no grading criterion (requires_field)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_evale2e-1",
        node_type: "eval",
        doco_id: docoId,
        eval: "Is the model good?",
        lifecycle: "active",
      },
    });
    expect(result.blocking?.sub_kind).toBe("requires_field");
  });

  it("passes a well-formed active Eval (membership + quality are advisory warns)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_evale2e-2",
        node_type: "eval",
        doco_id: docoId,
        eval: "Exact-match accuracy ≥ 0.9 on the 200-case sentiment golden set.",
        criterion: { kind: "exact" },
        lifecycle: "active",
      },
    });
    expect(result.blocking).toBeNull();
    expect(result.violations.every((v) => v.on_violation === "warn")).toBe(true);
  });

  it("does not hard-block an eval even when the judge rejects (the soft gates are warns)", async () => {
    // Both probabilistic eval gates (membership, eval-quality) are `warn`, so a
    // judge rejection surfaces a warning but never blocks a write.
    judge.run.mockResolvedValue({ ok: false, reason: "vague about what success means" });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "eval_evale2e-3",
        node_type: "eval",
        doco_id: docoId,
        eval: "works well",
        criterion: { kind: "llm-judge" },
        lifecycle: "active",
      },
    });
    expect(result.blocking).toBeNull();
    expect(
      result.violations.some((v) => v.kind === "probabilistic" && v.on_violation === "warn"),
    ).toBe(true);
  });
});
