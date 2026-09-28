// Real-life exercise of the `faq` Doco template against the REAL authoring
// stack — the template definition (`@doco/host` DEFAULT_DOCO_TEMPLATES), the
// host seam that seeds a Doco's `policies` from it (`createDocoInWorkspace`,
// against in-process PGlite loaded with the real schema.sql), and the pure
// authoring evaluator (`@doco/shared`), driven exactly as
// `authoring-runner.server` drives it. The only stubbed boundary is the LLM
// judge (Suite E), which can't run offline.
//
// The FAQ template carries two halves, mirroring the KCS model of an improvable
// Entry plus an immutable stream of Usage events:
//   - an Entry is a Reference (its `prose` is the question, `answer` the reply),
//   - a result is a Log (its `outcome` is `succeeded`/`failed`, and a resolved
//     result `supports` the entry that answered it).
// Eight real-life FAQs form the corpus (Suite A): if the template
// false-positives on a well-formed entry or a well-formed result Log, that is a
// defect. Suites B–E then prove it catches real modeling mistakes, implements
// the drafting exemption for the answer + steward gates, guards the edge-type
// allowlist, and wires the probabilistic checks end-to-end. A final suite
// exercises the logging half directly (resolved results and gap orphans).

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

const WORKSPACE_ID = "workspace_01FAQ0TEST000000000000001";
const USER_ID = "user_01FAQ0TEST0000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'faq-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'faq-test', 'Faq')", [
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
    requestedHandle: "help-center",
    createdByUserId: USER_ID,
    templateHandle: "faq",
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
    if (/belongs in an FAQ/i.test(s)) out.add("membership");
    else if (/the way a real user would ask/i.test(s)) out.add("question-quality");
    else if (/leads with the direct response/i.test(s)) out.add("answer-quality");
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

interface EntrySpec {
  question: string;
  answer: string;
  alternatives?: { name: string; note?: string }[];
  locator?: string;
  /** Index of a broader topic entry this one nests under (has_parent). */
  parent?: number;
  /** Index of another entry this one cross-references (relates_to). */
  related?: number;
}
interface ResultSpec {
  /** The question as actually asked (the Log's prose / raw query). */
  asked: string;
  happened_at: string;
  outcome: "succeeded" | "failed";
  /** Index of the entry this result resolved (supports edge). Omitted = a gap. */
  resolved?: number;
}
interface FaqSpec {
  key: string;
  steward: { name: string };
  entries: EntrySpec[];
  results?: ResultSpec[];
}

interface BuiltFaq extends Graph {
  steward: CandidateFields;
  entries: CandidateFields[];
  results: CandidateFields[];
}

/** Materialize an FAQ (steward Principal + entry References + result Logs + edges). */
function buildFaq(s: FaqSpec, lifecycle: Lifecycle): BuiltFaq {
  const steward = node("principal", s.key, { name: s.steward.name }, lifecycle);
  const entries = s.entries.map((e) =>
    node(
      "reference",
      s.key,
      {
        reference: e.question,
        answer: e.answer,
        ...(e.alternatives ? { alternatives: e.alternatives } : {}),
        ...(e.locator ? { locator: e.locator } : {}),
      },
      lifecycle,
    ),
  );
  const edges: EngineEdge[] = [];
  // Every entry is stewarded by the FAQ's owner.
  for (const e of entries) edges.push(edge(e.id, steward.id, "attributed_to"));
  // Cross-references and topic nesting where the scenario declares them.
  s.entries.forEach((e, i) => {
    if (e.parent != null) edges.push(edge(entries[i].id, entries[e.parent].id, "has_parent"));
    if (e.related != null) edges.push(edge(entries[i].id, entries[e.related].id, "relates_to"));
  });
  // Result Logs, each linked to the entry it resolved (a gap result links to nothing).
  const results = (s.results ?? []).map((r) =>
    node("log", s.key, { log: r.asked, happened_at: r.happened_at, outcome: r.outcome }, lifecycle),
  );
  s.results?.forEach((r, i) => {
    if (r.resolved != null) edges.push(edge(results[i].id, entries[r.resolved].id, "supports"));
  });
  return {
    nodes: [steward, ...entries, ...results],
    edges,
    principalIds: [steward.id],
    steward,
    entries,
    results,
  };
}

// ─── the eight real-life FAQs ──────────────────────────────────────────────────

const SCENARIOS: FaqSpec[] = [
  {
    key: "support",
    steward: { name: "Support Lead" },
    entries: [
      {
        question: "How do I reset my password?",
        answer:
          "Open the sign-in page, choose “Forgot password”, and enter your email — we send a reset link that stays valid for one hour.",
        alternatives: [{ name: "I forgot my password, how do I get back in?" }],
      },
      {
        question: "How do I change the email address on my account?",
        answer:
          "Go to Settings → Account, enter the new email, and confirm it from the verification message we send to that address.",
      },
    ],
    results: [
      {
        asked: "i can't log in, forgot my password",
        happened_at: "2026-05-02T10:14:00Z",
        outcome: "succeeded",
        resolved: 0,
      },
    ],
  },
  {
    key: "billing",
    steward: { name: "Billing Owner" },
    entries: [
      {
        question: "Why was my card declined?",
        answer:
          "Most declines are an expired card, insufficient funds, or a bank fraud hold. Check the card details in Billing, then retry; if it still fails, contact your bank.",
        alternatives: [{ name: "My payment failed — what happened?" }],
      },
      {
        question: "How do I update my payment method?",
        answer:
          "In Billing → Payment method, add the new card and set it as default; the next invoice charges the default card.",
        related: 0,
      },
      {
        question: "Where do I find my invoices?",
        answer: "Billing → Invoices lists every invoice with a PDF download for each.",
        locator: "https://docs.example.com/billing/invoices",
      },
    ],
    results: [
      {
        asked: "card keeps getting declined when i try to pay",
        happened_at: "2026-05-03T08:00:00Z",
        outcome: "succeeded",
        resolved: 0,
      },
      {
        asked: "can I pay by bank transfer instead of card?",
        happened_at: "2026-05-03T09:30:00Z",
        outcome: "failed",
      },
    ],
  },
  {
    key: "people",
    steward: { name: "People Ops" },
    entries: [
      {
        question: "How do I request time off?",
        answer:
          "Submit the dates in the HR portal under Time Off; your manager is notified and approves or declines, and you’ll get an email either way.",
        alternatives: [{ name: "How do I book vacation / PTO?" }],
      },
      {
        question: "How do I get reimbursed for an expense?",
        answer:
          "Upload the receipt in the Expenses tool within 30 days, pick the category, and submit; approved expenses are paid with the next payroll run.",
        locator: "https://intranet.example.com/finance/expenses",
      },
    ],
  },
  {
    key: "api",
    steward: { name: "Developer Relations" },
    entries: [
      {
        question: "What are the API rate limits?",
        answer:
          "The default is 600 requests per minute per API key. When you exceed it the API returns HTTP 429 with a Retry-After header — back off for that many seconds.",
        locator: "https://www.rfc-editor.org/rfc/rfc6585#section-4",
        alternatives: [{ name: "How many API requests can I make?" }],
      },
      {
        question: "How do I authenticate API requests?",
        answer:
          "Send your API key as a Bearer token in the Authorization header. Create and rotate keys in Settings → API keys.",
      },
      {
        question: "How do I page through a large result set?",
        answer:
          "Pass the `cursor` from a response’s `next` field on your following request; an empty `next` means you’ve reached the end.",
        parent: 0,
        related: 0,
      },
    ],
    results: [
      {
        asked: "getting 429 errors from the api, what do i do",
        happened_at: "2026-05-04T12:00:00Z",
        outcome: "succeeded",
        resolved: 0,
      },
    ],
  },
  {
    key: "shipping",
    steward: { name: "Fulfillment PM" },
    entries: [
      {
        question: "How long does delivery take?",
        answer:
          "Standard shipping arrives in 3–5 business days; express in 1–2. The estimate for your address is shown at checkout.",
        alternatives: [
          { name: "What is the shipping time?" },
          { name: "When will my order arrive?" },
        ],
      },
      {
        question: "How do I track my order?",
        answer:
          "Open the shipping confirmation email and tap “Track”, or find the tracking link under Orders in your account.",
        related: 0,
      },
    ],
  },
  {
    key: "security",
    steward: { name: "Security Engineering" },
    entries: [
      {
        question: "How do I enable two-factor authentication?",
        answer:
          "In Settings → Security, choose “Enable 2FA”, scan the QR code with an authenticator app, and confirm the six-digit code. Save the recovery codes somewhere safe.",
        alternatives: [{ name: "How do I turn on MFA / 2FA?" }],
      },
      {
        question: "I received a suspicious email — how do I report phishing?",
        answer:
          "Don’t click any links. Forward the message to security@example.com and then delete it; we’ll confirm whether it’s a threat.",
        locator: "https://intranet.example.com/security/report-phishing",
      },
    ],
    results: [
      {
        asked: "is this email from billing real or a scam?",
        happened_at: "2026-05-05T15:20:00Z",
        outcome: "succeeded",
        resolved: 1,
      },
    ],
  },
  {
    key: "onboarding",
    steward: { name: "IT Onboarding" },
    entries: [
      {
        question: "How do I set up my laptop on the first day?",
        answer:
          "Sign in with the temporary credentials from your welcome email, run the Setup app from the desktop, and it installs the standard tools and enrolls the device.",
      },
      {
        question: "How do I request additional equipment?",
        answer:
          "File a request in the IT portal under Equipment; your manager approves it and IT ships it to your address, usually within a week.",
        related: 0,
      },
    ],
  },
  {
    key: "product",
    steward: { name: "Product Manager" },
    entries: [
      {
        question: "How do I export my data?",
        answer:
          "Settings → Data → Export starts a full export; we email a download link when the archive is ready, usually within a few minutes.",
        alternatives: [{ name: "Can I download all my data?" }],
      },
      {
        question: "Is there a mobile app?",
        answer:
          "Yes — native apps for iOS and Android are on the App Store and Google Play, and they sign in with the same account as the web app.",
      },
    ],
  },
];

// ─── Suite A: no false positives on eight well-formed FAQs ────────────────────

describe("faq template — eight real-life FAQs (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, requires_field(answer),
    // requires_edge(attributed_to → principal) → deterministic; membership +
    // question-quality + answer-quality → probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(5);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node (entry, result Log, steward) passes the deterministic gates with no block or warn`, () => {
      const g = buildFaq(s, "active");
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

  it("queues exactly the right probabilistic checks per node type (support)", () => {
    const g = buildFaq(SCENARIOS[0], "active");
    // A committed entry gets the soft membership gate plus both quality judges.
    expect(probabilisticLabels(evaluate(g.entries[0], g))).toEqual(
      new Set(["membership", "question-quality", "answer-quality"]),
    );
    // A steward Principal is exempt from all three (they are reference-scoped).
    expect(probabilisticLabels(evaluate(g.steward, g))).toEqual(new Set());
    // A result Log is exempt too — the logging half carries no quality judge.
    expect(probabilisticLabels(evaluate(g.results[0], g))).toEqual(new Set());
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("faq template — blocks malformed entries", () => {
  it("blocks a committed entry that carries no answer (the completeness floor)", () => {
    const g = buildFaq(SCENARIOS[0], "active");
    // An entry with a steward edge but no answer.
    const noAnswer = node("reference", "support", { reference: "How do I cancel?" }, "active");
    g.nodes.push(noAnswer);
    g.edges.push(edge(noAnswer.id, g.steward.id, "attributed_to"));
    const blocks = deterministicBlocks(evaluate(noAnswer, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_field");
    expect(blocks.some((b) => /answer/.test(b.reason))).toBe(true);
  });

  it("blocks a committed entry with no stewarding Principal (the ownership floor)", () => {
    const g = buildFaq(SCENARIOS[0], "active");
    // A complete answer, but no attributed_to edge to an owner.
    const unowned = node(
      "reference",
      "support",
      { reference: "How do I cancel?", answer: "Open Settings → Plan and choose Cancel." },
      "active",
    );
    g.nodes.push(unowned);
    const blocks = deterministicBlocks(evaluate(unowned, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge")).toBe(true);
  });

  it("blocks node types outside the allowlist (action, decision, intent, state, eval, rule, idea)", () => {
    const g = buildFaq(SCENARIOS[0], "active");
    for (const t of ["action", "decision", "intent", "state", "eval", "rule", "idea"]) {
      const stray = node(t, "support", { [t]: "stray content", answer: "x" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits a result Log (no block) — the logging half is first-class content", () => {
    const g = buildFaq(SCENARIOS[0], "active");
    const result = node(
      "log",
      "support",
      {
        log: "how do i reset my password",
        happened_at: "2026-05-06T00:00:00Z",
        outcome: "succeeded",
      },
      "active",
    );
    expect(deterministicBlocks(evaluate(result, g))).toEqual([]);
  });

  it("admits a steward Principal (no block)", () => {
    const g = buildFaq(SCENARIOS[0], "active");
    const steward = node("principal", "support", { name: "Docs Owner" }, "active");
    expect(deterministicBlocks(evaluate(steward, g))).toEqual([]);
  });
});

// ─── Suite C: answer + steward required only once committed; drafting exempt ────

describe("faq template — completeness required only once committed", () => {
  function bareEntryAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    // A bare question: no answer, and no steward edge.
    const g = buildFaq(SCENARIOS[3], lifecycle);
    const bare = node("reference", "api", { reference: "How do I use webhooks?" }, lifecycle);
    g.nodes.push(bare);
    return { candidate: bare, graph: g };
  }
  const missingAnswer = (b: Violation) =>
    b.sub_kind === "requires_field" && /answer/.test(b.reason);
  const missingSteward = (b: Violation) => b.sub_kind === "requires_edge";

  it("a drafting entry may be a bare question (no answer, no steward required)", () => {
    const { candidate, graph } = bareEntryAt("drafting");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingAnswer)).toBe(false);
    expect(blocks.some(missingSteward)).toBe(false);
  });

  it("a queued entry must carry its answer and name its steward", () => {
    const { candidate, graph } = bareEntryAt("queued");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingAnswer)).toBe(true);
    expect(blocks.some(missingSteward)).toBe(true);
  });

  it("an active entry must carry its answer and name its steward", () => {
    const { candidate, graph } = bareEntryAt("active");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingAnswer)).toBe(true);
    expect(blocks.some(missingSteward)).toBe(true);
  });

  it("a retired (archived) entry is not re-judged for completeness", () => {
    const { candidate, graph } = bareEntryAt("retired");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingAnswer)).toBe(false);
    expect(blocks.some(missingSteward)).toBe(false);
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("faq template — edge-type allowlist", () => {
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
    "relates_to",
    "has_parent",
    "replaces",
    "derived_from",
  ]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  // No sequence flow and no policy-guard edges in a Q&A knowledge base.
  for (const denied of ["flows_to", "constrained_by"]) {
    it(`bars \`${denied}\``, () => {
      expect(barred(evalEdge(denied))).toBe(true);
    });
  }
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("faq template — end-to-end via runAuthoringPolicies", () => {
  it("blocks a Decision via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "decision_faqe2e-0",
        node_type: "decision",
        doco_id: docoId,
        decision: "Pick a vendor.",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed entry missing its answer AND its steward (both completeness floors)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "reference_faqe2e-1",
        node_type: "reference",
        doco_id: docoId,
        reference: "How do I cancel my subscription?",
        lifecycle: "active",
      },
    });
    expect(result.blocking).not.toBeNull();
    const blocks = result.violations.filter(
      (v) => v.kind === "deterministic" && v.on_violation === "block",
    );
    expect(blocks.some((v) => v.sub_kind === "requires_field")).toBe(true);
    expect(blocks.some((v) => v.sub_kind === "requires_edge")).toBe(true);
  });

  it("passes a drafting entry (committed-only gates are exempt; soft gates are advisory)", async () => {
    // A drafting stub — a bare question with no answer and no steward — is a work
    // in progress, so the answer + steward floors don't fire and the membership
    // judge (stubbed ok) raises nothing.
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "reference_faqe2e-2",
        node_type: "reference",
        doco_id: docoId,
        reference: "How do I cancel my subscription?",
        lifecycle: "drafting",
      },
    });
    expect(result.blocking).toBeNull();
  });

  it("does not hard-block an entry even when the judge rejects (the quality gates are warns)", async () => {
    // The question/answer quality judges are `warn`, so a judge rejection on a
    // committed entry surfaces a warning but never blocks the write.
    judge.run.mockResolvedValue({ ok: false, reason: "answer never states the actual answer" });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "reference_faqe2e-3",
        node_type: "reference",
        doco_id: docoId,
        reference: "How do I cancel my subscription?",
        answer: "Cancellation is an interesting topic with many considerations.",
        lifecycle: "drafting",
      },
    });
    expect(result.blocking).toBeNull();
    expect(
      result.violations.some((v) => v.kind === "probabilistic" && v.on_violation === "warn"),
    ).toBe(true);
  });
});

// ─── Suite F: the logging half (results, outcomes, gaps) ──────────────────────

describe("faq template — result logs (the usage half)", () => {
  it("admits a resolved result Log linked to its entry via `supports` (reuse is review)", () => {
    const g = buildFaq(SCENARIOS[1], "active");
    const resolved = node(
      "log",
      "billing",
      {
        log: "why did my card get declined",
        happened_at: "2026-05-07T00:00:00Z",
        outcome: "succeeded",
      },
      "active",
    );
    g.nodes.push(resolved);
    g.edges.push(edge(resolved.id, g.entries[0].id, "supports"));
    expect(deterministicBlocks(evaluate(resolved, g))).toEqual([]);
    expect(deterministicWarns(evaluate(resolved, g))).toEqual([]);
    // The supporting edge type is admitted by the allowlist.
    const edgeVs = evaluateEdgePolicies({
      edge: { edge_type: "supports" } as EdgeCandidate,
      policies,
      includeProbabilistic: false,
    });
    expect(edgeVs.some((v) => v.sub_kind === "requires_edge_type")).toBe(false);
  });

  it("admits a gap result Log — an orphan with `outcome: failed` and no `supports` edge", () => {
    // The miss is the most valuable signal: a result that found no answer is a
    // legal orphan, not a modeling error, and its raw question drives the next
    // entry to write.
    const g = buildFaq(SCENARIOS[1], "active");
    const gap = node(
      "log",
      "billing",
      { log: "can i pay with crypto?", happened_at: "2026-05-08T00:00:00Z", outcome: "failed" },
      "active",
    );
    g.nodes.push(gap);
    expect(deterministicBlocks(evaluate(gap, g))).toEqual([]);
    expect(deterministicWarns(evaluate(gap, g))).toEqual([]);
  });

  it("admits a new entry whose provenance is the gap Log it was written to fill (`derived_from`)", () => {
    const g = buildFaq(SCENARIOS[1], "active");
    const gap = node(
      "log",
      "billing",
      { log: "can i pay with crypto?", happened_at: "2026-05-08T00:00:00Z", outcome: "failed" },
      "active",
    );
    const filler = node(
      "reference",
      "billing",
      {
        reference: "Can I pay with cryptocurrency?",
        answer: "Not yet — we accept cards and bank transfer; crypto is on the roadmap.",
      },
      "active",
    );
    g.nodes.push(gap, filler);
    g.edges.push(edge(filler.id, g.steward.id, "attributed_to"));
    g.edges.push(edge(filler.id, gap.id, "derived_from"));
    expect(deterministicBlocks(evaluate(filler, g))).toEqual([]);
    const edgeVs = evaluateEdgePolicies({
      edge: { edge_type: "derived_from" } as EdgeCandidate,
      policies,
      includeProbabilistic: false,
    });
    expect(edgeVs.some((v) => v.sub_kind === "requires_edge_type")).toBe(false);
  });
});
