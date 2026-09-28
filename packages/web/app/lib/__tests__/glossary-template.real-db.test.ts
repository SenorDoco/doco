// Real-life exercise of the `glossary` Doco template against the REAL
// authoring stack — the template definition (`@doco/host`
// DEFAULT_DOCO_TEMPLATES), the host seam that seeds a Doco's `policies` from it
// (`createDocoInWorkspace`, against in-process PGlite loaded with the real
// schema.sql), and the pure authoring evaluator (`@doco/shared`), driven
// exactly as `authoring-runner.server` drives it. The only stubbed boundary is
// the LLM judge (Suite E), which can't run offline.
//
// Ten real-world glossaries form the corpus (Suite A): if the template
// false-positives on a well-formed entry, that is a defect. Suites B–E then
// prove it catches real modeling mistakes, implements the drafting exemption,
// guards the edge-type allowlist, and wires the probabilistic checks
// end-to-end.

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

const WORKSPACE_ID = "workspace_01GLOSTEST000000000000001";
const USER_ID = "user_01GLOSTEST0000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'glos-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'glos-test', 'Glos')", [
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
    requestedHandle: "lexicon",
    createdByUserId: USER_ID,
    templateHandle: "glossary",
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
    if (/belongs in a glossary/i.test(s)) out.add("membership");
    else if (/concise, self-contained explanation|circular/i.test(s)) out.add("definition-quality");
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

interface TermSpec {
  word: string;
  definition: string;
  alternatives?: { name: string; rejected_because?: string }[];
  locator?: string;
  /** Index of another term this one is a narrower child of (has_parent). */
  parent?: number;
  /** Index of another term this one cross-references (relates_to). */
  related?: number;
}
interface GlossarySpec {
  key: string;
  steward: { name: string; body: string };
  terms: TermSpec[];
}

interface BuiltGlossary extends Graph {
  steward: CandidateFields;
  terms: CandidateFields[];
}

/** Materialize a glossary (steward Principal + term References + edges). */
function buildGlossary(s: GlossarySpec, lifecycle: Lifecycle): BuiltGlossary {
  const steward = node("principal", s.key, { name: s.steward.name }, lifecycle);
  const terms = s.terms.map((t) =>
    node(
      "reference",
      s.key,
      {
        reference: t.word,
        definition: t.definition,
        ...(t.alternatives ? { alternatives: t.alternatives } : {}),
        ...(t.locator ? { locator: t.locator } : {}),
      },
      lifecycle,
    ),
  );
  const edges: EngineEdge[] = [];
  // Every term is stewarded by the glossary's owner.
  for (const t of terms) edges.push(edge(t.id, steward.id, "attributed_to"));
  // Cross-references and hierarchy where the scenario declares them.
  s.terms.forEach((t, i) => {
    if (t.parent != null) edges.push(edge(terms[i].id, terms[t.parent].id, "has_parent"));
    if (t.related != null) edges.push(edge(terms[i].id, terms[t.related].id, "relates_to"));
  });
  return {
    nodes: [steward, ...terms],
    edges,
    principalIds: [steward.id],
    steward,
    terms,
  };
}

// ─── the ten real-life glossaries ──────────────────────────────────────────────

const SCENARIOS: GlossarySpec[] = [
  {
    key: "fintech",
    steward: { name: "Payments Lead", body: "Owns the payments domain vocabulary." },
    terms: [
      {
        word: "chargeback",
        definition:
          "A forced reversal of a card payment initiated by the cardholder's bank, returning funds to the buyer.",
        alternatives: [{ name: "dispute reversal" }],
      },
      {
        word: "settlement",
        definition:
          "The transfer of captured funds from the acquirer to the merchant's account, net of fees.",
        related: 0,
      },
      {
        word: "interchange fee",
        definition:
          "The fee paid by the acquirer to the card-issuing bank on each transaction, set by the card network.",
        parent: 1,
      },
    ],
  },
  {
    key: "clinical",
    steward: { name: "Clinical Informatics", body: "Maintains clinical terminology." },
    terms: [
      {
        word: "triage",
        definition:
          "The process of ranking patients by the urgency of their need for care when resources are limited.",
      },
      {
        word: "comorbidity",
        definition:
          "The presence of one or more additional conditions alongside a primary diagnosis.",
      },
      {
        word: "discharge summary",
        definition:
          "A clinical document recording a patient's diagnosis, treatment, and follow-up plan at the end of an admission.",
        locator: "https://www.hl7.org/fhir/composition.html",
      },
    ],
  },
  {
    key: "legal",
    steward: { name: "Contracts Counsel", body: "Owns contract-term definitions." },
    terms: [
      {
        word: "indemnification",
        definition:
          "A contractual obligation by one party to compensate another for specified losses or damages.",
        alternatives: [{ name: "hold harmless" }],
      },
      {
        word: "force majeure",
        definition:
          "A clause freeing both parties from liability when an extraordinary event beyond their control prevents performance.",
        locator: "Black's Law Dictionary, 11th ed.",
      },
      {
        word: "liquidated damages",
        definition:
          "A sum fixed in advance by the parties as the agreed compensation for a specific breach.",
        related: 0,
      },
    ],
  },
  {
    key: "api",
    steward: { name: "Platform Architect", body: "Owns the HTTP API vocabulary." },
    terms: [
      {
        word: "idempotent",
        definition:
          "An operation that produces the same result whether it is applied once or many times.",
        locator: "https://www.rfc-editor.org/rfc/rfc7231#section-4.2.2",
      },
      {
        word: "pagination",
        definition:
          "Splitting a large result set into sequential pages so a client can fetch it in bounded chunks.",
      },
      {
        word: "cursor",
        definition:
          "An opaque token marking a position in a result set, passed back to fetch the next page.",
        parent: 1,
        related: 1,
      },
    ],
  },
  {
    key: "ml",
    steward: { name: "ML Platform", body: "Owns machine-learning terminology." },
    terms: [
      {
        word: "overfitting",
        definition:
          "When a model learns noise in the training data and so generalizes poorly to unseen data.",
        alternatives: [{ name: "high variance" }],
      },
      {
        word: "regularization",
        definition:
          "A technique that penalizes model complexity to reduce overfitting and improve generalization.",
        related: 0,
      },
      {
        word: "embedding",
        definition:
          "A dense vector representation of a discrete input that places similar inputs near each other.",
      },
    ],
  },
  {
    key: "security",
    steward: { name: "Security Engineering", body: "Owns the security glossary." },
    terms: [
      {
        word: "phishing",
        definition:
          "A social-engineering attack that tricks a victim into revealing credentials by impersonating a trusted party.",
      },
      {
        word: "principle of least privilege",
        definition:
          "The practice of granting each actor only the permissions required to perform its task, and no more.",
        alternatives: [{ name: "PoLP" }],
      },
      {
        word: "zero trust",
        definition:
          "A security model that authenticates and authorizes every request regardless of network location.",
        related: 1,
      },
    ],
  },
  {
    key: "devops",
    steward: { name: "SRE Lead", body: "Owns reliability terminology." },
    terms: [
      {
        word: "SLO",
        definition:
          "A target level of reliability for a service over a window, such as 99.9% successful requests per month.",
        alternatives: [{ name: "service level objective" }],
      },
      {
        word: "error budget",
        definition:
          "The allowed amount of unreliability over a window — the complement of the SLO — that may be spent on change.",
        parent: 0,
        related: 0,
      },
      {
        word: "toil",
        definition:
          "Manual, repetitive operational work that scales with service size and produces no lasting value.",
      },
    ],
  },
  {
    key: "people",
    steward: { name: "People Ops", body: "Owns HR terminology." },
    terms: [
      {
        word: "onboarding",
        definition:
          "The process of integrating a new hire into the organization, its tools, and its culture.",
      },
      {
        word: "attrition",
        definition: "The rate at which employees leave the organization over a given period.",
        alternatives: [{ name: "churn", rejected_because: "ambiguous with revenue churn" }],
      },
      {
        word: "OKR",
        definition:
          "A goal-setting framework pairing a qualitative Objective with measurable Key Results.",
        locator: "https://en.wikipedia.org/wiki/OKR",
      },
    ],
  },
  {
    key: "data",
    steward: { name: "Data Governance", body: "Owns the data-governance glossary." },
    terms: [
      {
        word: "PII",
        definition:
          "Personally identifiable information — any data that can identify a specific individual.",
        alternatives: [{ name: "personal data" }],
      },
      {
        word: "data lineage",
        definition:
          "The record of where data originates and how it moves and transforms through systems.",
      },
      {
        word: "golden record",
        definition:
          "The single, authoritative version of an entity reconciled from multiple source systems.",
        related: 1,
      },
    ],
  },
  {
    key: "ecommerce",
    steward: { name: "Retail PM", body: "Owns the e-commerce glossary." },
    terms: [
      {
        word: "cart abandonment",
        definition:
          "When a shopper adds items to a cart but leaves before completing the purchase.",
      },
      {
        word: "SKU",
        definition:
          "Stock keeping unit — a unique identifier for a distinct sellable product variant.",
        alternatives: [{ name: "stock keeping unit" }],
      },
      {
        word: "conversion rate",
        definition:
          "The share of visitors who complete a desired action, such as a purchase, out of all visitors.",
        related: 0,
      },
    ],
  },
];

// ─── Suite A: no false positives on ten well-formed glossaries ────────────────

describe("glossary template — ten real-life glossaries (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, requires_field(definition) →
    // deterministic; membership + definition-quality → probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(4);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node passes the deterministic gates with no block or warn`, () => {
      const g = buildGlossary(s, "active");
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

  it("queues exactly the right probabilistic checks per node type (fintech)", () => {
    const g = buildGlossary(SCENARIOS[0], "active");
    // A committed term gets both the soft membership gate and the
    // definition-quality judge.
    expect(probabilisticLabels(evaluate(g.terms[0], g))).toEqual(
      new Set(["membership", "definition-quality"]),
    );
    // A steward Principal is exempt from both (they are reference-scoped).
    expect(probabilisticLabels(evaluate(g.steward, g))).toEqual(new Set());
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("glossary template — blocks malformed entries", () => {
  it("blocks a committed term that carries no definition (the completeness floor)", () => {
    const g = buildGlossary(SCENARIOS[0], "active");
    const bare = node("reference", "fintech", { reference: "acquirer" }, "active");
    g.nodes.push(bare);
    const blocks = deterministicBlocks(evaluate(bare, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_field");
    expect(blocks.some((b) => /definition/.test(b.reason))).toBe(true);
  });

  it("blocks node types outside the allowlist (action, decision, log, idea, eval, intent, state, rule)", () => {
    const g = buildGlossary(SCENARIOS[0], "active");
    for (const t of ["action", "decision", "log", "idea", "eval", "intent", "state", "rule"]) {
      const stray = node(t, "fintech", { [t]: "stray content", definition: "x" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits a steward Principal (no block)", () => {
    const g = buildGlossary(SCENARIOS[0], "active");
    const steward = node("principal", "fintech", { name: "Risk Owner" }, "active");
    expect(deterministicBlocks(evaluate(steward, g))).toEqual([]);
  });
});

// ─── Suite C: the definition floor is committed-only; drafting is exempt ───────

describe("glossary template — definition required only once committed", () => {
  function bareTermAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildGlossary(SCENARIOS[3], lifecycle);
    const bare = node("reference", "api", { reference: "webhook" }, lifecycle);
    g.nodes.push(bare);
    return { candidate: bare, graph: g };
  }
  const missingDefinition = (b: Violation) =>
    b.sub_kind === "requires_field" && /definition/.test(b.reason);

  it("a drafting term may be a bare headword (no definition required)", () => {
    const { candidate, graph } = bareTermAt("drafting");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingDefinition)).toBe(false);
  });

  it("a queued term must carry its definition", () => {
    const { candidate, graph } = bareTermAt("queued");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingDefinition)).toBe(true);
  });

  it("an active term must carry its definition", () => {
    const { candidate, graph } = bareTermAt("active");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingDefinition)).toBe(true);
  });

  it("a retired (deprecated) term is not re-judged for completeness", () => {
    const { candidate, graph } = bareTermAt("retired");
    expect(deterministicBlocks(evaluate(candidate, graph)).some(missingDefinition)).toBe(false);
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("glossary template — edge-type allowlist", () => {
  const evalEdge = (edge_type: string): Violation[] =>
    evaluateEdgePolicies({
      edge: { edge_type } as EdgeCandidate,
      policies,
      includeProbabilistic: false,
    });
  const barred = (vs: Violation[]) =>
    vs.some((v) => v.sub_kind === "requires_edge_type" && v.on_violation === "block");

  for (const allowed of ["relates_to", "has_parent", "replaces", "attributed_to"]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  for (const denied of ["derived_from", "flows_to", "supports", "constrained_by"]) {
    it(`bars \`${denied}\``, () => {
      expect(barred(evalEdge(denied))).toBe(true);
    });
  }
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("glossary template — end-to-end via runAuthoringPolicies", () => {
  it("blocks a Decision via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "decision_glose2e-0",
        node_type: "decision",
        doco_id: docoId,
        decision: "Pick a vendor.",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed term with no definition (requires_field)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "reference_glose2e-1",
        node_type: "reference",
        doco_id: docoId,
        reference: "acquirer",
        lifecycle: "active",
      },
    });
    expect(result.blocking?.sub_kind).toBe("requires_field");
  });

  it("passes a well-formed active term (membership + quality are advisory warns)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "reference_glose2e-2",
        node_type: "reference",
        doco_id: docoId,
        reference: "settlement",
        definition: "The transfer of captured funds to the merchant, net of fees.",
        lifecycle: "active",
      },
    });
    expect(result.blocking).toBeNull();
    expect(result.violations.every((v) => v.on_violation === "warn")).toBe(true);
  });

  it("does not hard-block a term even when the judge rejects (the soft gates are warns)", async () => {
    // Both probabilistic glossary gates (membership, definition-quality) are
    // `warn`, so a judge rejection surfaces a warning but never blocks a write.
    judge.run.mockResolvedValue({ ok: false, reason: "reads like a circular definition" });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "reference_glose2e-3",
        node_type: "reference",
        doco_id: docoId,
        reference: "widget",
        definition: "A widget is a widget.",
        lifecycle: "active",
      },
    });
    expect(result.blocking).toBeNull();
    expect(
      result.violations.some((v) => v.kind === "probabilistic" && v.on_violation === "warn"),
    ).toBe(true);
  });
});
