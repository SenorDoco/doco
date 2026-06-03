// Real-life exercise of the `business-processes` Doco template against the
// REAL authoring stack.
//
// The template is the product here: it is meant to be the best abstraction
// for documenting a repeatable business process (BPMN swimlanes + gateways),
// and it must behave correctly under the current architecture — the four-stage
// node lifecycle `drafting → queued → active → retired` (the `queued` stage
// is new; `active` was formerly `asserted`) and the unified `policies` table
// (one row per policy, classified by a standalone `kind`).
//
// What runs for real:
//   - the template definition itself (`@doco/host` DEFAULT_DOCO_TEMPLATES),
//   - the host seam that seeds a Doco's `policies` rows from it
//     (`createDocoInWorkspace`, against an in-process PGlite loaded with the
//     real schema.sql), and
//   - the pure authoring evaluator (`@doco/shared` evaluatePolicies), driven
//     exactly as `authoring-runner.server` drives it (same lifecycle filter,
//     same terminal-skip rule).
// The only stubbed boundary is the LLM judge (Suite C), which can't run
// offline. Everything else is real Postgres semantics + real template policy.
//
// Ten real-world processes form the corpus (Suite A): if the template
// false-positives on a well-formed, well-wired process, that is a defect.
// Suites B–D then prove it catches real modeling mistakes, implements the
// `queued` lifecycle adaptation, and wires probabilistic checks end-to-end.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CandidateFields,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  type Violation,
  evaluatePolicies,
  isDeterministicPredicate,
} from "@doco/shared";
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
import { runAuthoringPolicies } from "../authoring-runner.server";

const WORKSPACE_ID = "workspace_01BPTEST0000000000000001";
const USER_ID = "user_01BPTEST00000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'bp-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name, data) VALUES ($1,'bp-test','BP Test','{}')",
    [WORKSPACE_ID],
  );
  // Owner role → createDocoInWorkspace skips the redundant doco_users grant.
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
    // The runner only enforces deterministic + probabilistic policies;
    // suggestions (the template's prose guidance) are advisory.
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

// The seeded template policies are static, so build the Doco once. The
// in-memory scenario graphs never touch the DB, and Suite D's runner reads
// (never mutates) the seeded `policies`, so a single shared PGlite is safe
// and keeps the schema load off the per-test path.
beforeAll(async () => {
  dbm.db = new PGlite();
  await dbm.db.exec(schemaSql);
  await seedWorkspaceAndUser();
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "orders",
    createdByUserId: USER_ID,
    templateHandle: "business-processes",
  });
  docoId = created.docoId;
  policies = await loadSeededPolicies(docoId);
});

beforeEach(() => {
  judge.run.mockReset();
});

// ─── evaluation harness (mirrors authoring-runner.server) ─────────────────────

// Deterministic checks that assert a lifecycle-independent invariant — they
// keep firing even on a terminal (retired) candidate. Mirrors
// LIFECYCLE_INDEPENDENT_KINDS in authoring-runner.server.
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

/** Evaluate one candidate against the seeded template policies, exactly as the runner would. */
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

/** Classify a fired probabilistic check by a stable keyword in its spec. */
function probabilisticLabels(vs: Violation[]): Set<string> {
  const out = new Set<string>();
  for (const v of vs) {
    if (v.kind !== "probabilistic") continue;
    const s = v.pending_spec ?? v.reason;
    if (/belongs in business-processes|repeatable structure/i.test(s)) out.add("membership");
    else if (/exclusiveGateway|Implementation status|Source type/i.test(s))
      out.add("imported-metadata");
    else if (/FIRST LINE|brief process name/i.test(s)) out.add("intent-headline");
    else if (/single business activity|atomic/i.test(s)) out.add("atomic-activity");
    else if (/enumeration|exhaustive|default\/else/i.test(s)) out.add("gateway-exhaustive");
    else if (/milestone or entry\/exit condition/i.test(s)) out.add("milestone-naming");
    else if (/swim-lane|role, team, external party/i.test(s)) out.add("principal-lane");
  }
  return out;
}

// ─── node / graph builders ────────────────────────────────────────────────────

let seq = 0;
function nid(type: string, key: string): string {
  // Suffix uses hyphens only: entityTypeFromId() splits on the LAST `_`.
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
function edge(
  from: string,
  to: string,
  edge_type: string,
  role: string,
  props: Record<string, unknown> = {},
): EngineEdge {
  return { from_id: from, to_id: to, edge_type, edge_props_json: { role, ...props } };
}

interface ScenarioSpec {
  key: string;
  intent: string;
  principals: { name: string; body: string }[];
  actions: { text: string; verb: string; actor: number }[];
  gateway: { decision: string; question: string; chosen: string; alternatives: { name: string }[] };
  initialState: string;
  terminalStates: string[];
  evalText: string;
}

interface BuiltProcess extends Graph {
  intent: CandidateFields;
  principals: CandidateFields[];
  actions: CandidateFields[];
  gateway: CandidateFields;
  states: CandidateFields[];
  evalNode: CandidateFields;
}

/** Materialize a fully-wired BPMN process at the given lifecycle. */
function buildProcess(s: ScenarioSpec, lifecycle: Lifecycle): BuiltProcess {
  const intent = node("intent", s.key, { intent: s.intent }, lifecycle);
  const principals = s.principals.map((p) =>
    node("principal", s.key, { name: p.name, body_md: p.body }, lifecycle),
  );
  const actions = s.actions.map((a) =>
    node("action", s.key, { action: a.text, verb: a.verb }, lifecycle),
  );
  const gateway = node(
    "decision",
    s.key,
    {
      decision: s.gateway.decision,
      question: s.gateway.question,
      chosen: s.gateway.chosen,
      alternatives: s.gateway.alternatives,
    },
    lifecycle,
  );
  const initial = node("state", s.key, { state: s.initialState, kind: "initial" }, lifecycle);
  const terminals = s.terminalStates.map((t) =>
    node("state", s.key, { state: t, kind: "terminal" }, lifecycle),
  );
  const states = [initial, ...terminals];
  const evalNode = node(
    "eval",
    s.key,
    { eval: s.evalText, criterion: { kind: "llm-judge" } },
    lifecycle,
  );

  const edges: EngineEdge[] = [];
  // Every flow node `serves` the process Intent (supports / role:serves).
  for (const n of [...actions, gateway, ...states])
    edges.push(edge(n.id, intent.id, "supports", "serves"));
  // Every Action is `performed_by` a Principal (attributed_to / role:performed_by).
  actions.forEach((a, i) =>
    edges.push(edge(a.id, principals[s.actions[i].actor].id, "attributed_to", "performed_by")),
  );
  // The process owner is `owned_by` the first Principal.
  edges.push(edge(intent.id, principals[0].id, "attributed_to", "owned_by"));
  // The Eval `tests` the gateway (supports / role:tests).
  edges.push(edge(evalNode.id, gateway.id, "supports", "tests"));
  // Forward sequence flow: initial → action(s) → gateway → terminals.
  const chain = [initial, ...actions, gateway];
  for (let i = 0; i < chain.length - 1; i++)
    edges.push(edge(chain[i].id, chain[i + 1].id, "flows_to", ""));
  for (const t of terminals)
    edges.push(edge(gateway.id, t.id, "flows_to", "", { condition: t.state }));

  const nodes = [intent, ...principals, ...actions, gateway, ...states, evalNode];
  return {
    nodes,
    edges,
    principalIds: principals.map((p) => p.id),
    intent,
    principals,
    actions,
    gateway,
    states,
    evalNode,
  };
}

// ─── the ten real-life processes ──────────────────────────────────────────────

const SCENARIOS: ScenarioSpec[] = [
  {
    key: "loan-approval",
    intent:
      "Approve a consumer loan\n\nTrigger: an applicant submits a loan request. Outcome: funds are disbursed or the request is declined. Out of scope: collections and servicing after disbursement.",
    principals: [
      {
        name: "Loan Officer",
        body: "Owns intake and the initial credit decision for retail loan applications.",
      },
      {
        name: "Underwriter",
        body: "Reviews risk and signs off on funding above the auto-approval threshold.",
      },
    ],
    actions: [
      { text: "review the application", verb: "review", actor: 0 },
      { text: "run the credit check", verb: "check", actor: 0 },
      { text: "underwrite the loan", verb: "underwrite", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether the credit score clears the auto-approval bar.",
      question: "Is the credit score above the approval threshold?",
      chosen: "Route above-threshold applications to disbursement",
      alternatives: [{ name: "above threshold → disburse" }, { name: "below threshold → decline" }],
    },
    initialState: "application received",
    terminalStates: ["loan disbursed", "application declined"],
    evalText: "Confirms the gateway has a default branch so every credit score is routed.",
  },
  {
    key: "employee-onboarding",
    intent:
      "Onboard a new employee\n\nTrigger: a candidate accepts an offer. Outcome: the new hire is active with accounts, equipment, and orientation complete. Out of scope: recruiting and offer negotiation.",
    principals: [
      {
        name: "HR Coordinator",
        body: "Owns the onboarding checklist and the new-hire's first-day experience.",
      },
      { name: "IT Provisioner", body: "Creates accounts and ships equipment for new hires." },
    ],
    actions: [
      { text: "collect the signed paperwork", verb: "collect", actor: 0 },
      { text: "provision the accounts", verb: "provision", actor: 1 },
      { text: "ship the laptop", verb: "ship", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether all onboarding prerequisites are complete before day one.",
      question: "Are accounts and equipment ready?",
      chosen: "Proceed to orientation when ready",
      alternatives: [{ name: "ready → orientation" }, { name: "not ready → escalate" }],
    },
    initialState: "offer accepted",
    terminalStates: ["employee active"],
    evalText:
      "Confirms every new hire reaches active only after accounts and equipment are provisioned.",
  },
  {
    key: "order-fulfillment",
    intent:
      "Fulfill an e-commerce order\n\nTrigger: a customer places an order. Outcome: the order is delivered or cancelled. Out of scope: returns and refunds after delivery.",
    principals: [
      { name: "Warehouse Operator", body: "Picks and packs orders on the fulfillment floor." },
      {
        name: "Payments Service",
        body: "External processor that authorizes and captures card payments.",
      },
    ],
    actions: [
      { text: "capture the payment", verb: "capture", actor: 1 },
      { text: "pick the items", verb: "pick", actor: 0 },
      { text: "pack the shipment", verb: "pack", actor: 0 },
    ],
    gateway: {
      decision: "Decide whether the payment was captured successfully.",
      question: "Was the payment captured?",
      chosen: "Ship captured orders",
      alternatives: [{ name: "captured → ship" }, { name: "declined → cancel" }],
    },
    initialState: "order placed",
    terminalStates: ["order delivered", "order cancelled"],
    evalText: "Confirms a declined payment routes to the cancelled terminal state.",
  },
  {
    key: "insurance-claim",
    intent:
      "Adjudicate an insurance claim\n\nTrigger: a policyholder files a claim. Outcome: the claim is paid or denied. Out of scope: premium billing and policy renewal.",
    principals: [
      { name: "Claims Adjuster", body: "Assesses claim validity and sets the payout amount." },
      { name: "Fraud Investigator", body: "Reviews flagged claims for fraud indicators." },
    ],
    actions: [
      { text: "triage the claim", verb: "triage", actor: 0 },
      { text: "investigate the loss", verb: "investigate", actor: 1 },
      { text: "calculate the payout", verb: "calculate", actor: 0 },
    ],
    gateway: {
      decision: "Decide whether the claim is valid, fraudulent, or needs more information.",
      question: "Is the claim valid, fraudulent, or insufficient?",
      chosen: "Pay valid claims",
      alternatives: [
        { name: "valid → pay" },
        { name: "fraudulent → deny" },
        { name: "insufficient → request info" },
      ],
    },
    initialState: "claim filed",
    terminalStates: ["claim paid", "claim denied"],
    evalText:
      "Confirms every enumerated verdict (valid / fraudulent / insufficient) has an outgoing branch.",
  },
  {
    key: "expense-reimbursement",
    intent:
      "Reimburse an expense report\n\nTrigger: an employee submits an expense report. Outcome: the employee is reimbursed or the report is rejected. Out of scope: corporate card reconciliation.",
    principals: [
      { name: "Line Manager", body: "Approves or rejects their reports' expense submissions." },
      { name: "Finance Clerk", body: "Validates receipts and issues reimbursements." },
    ],
    actions: [
      { text: "approve the expense report", verb: "approve", actor: 0 },
      { text: "validate the receipts", verb: "validate", actor: 1 },
      { text: "issue the reimbursement", verb: "issue", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether the manager approves the expense report.",
      question: "Did the manager approve the report?",
      chosen: "Send approved reports to finance",
      alternatives: [
        { name: "approved → finance review" },
        { name: "rejected → return to employee" },
      ],
    },
    initialState: "report submitted",
    terminalStates: ["expense reimbursed", "report rejected"],
    evalText: "Confirms rejected reports route back to the employee rather than to payment.",
  },
  {
    key: "support-ticket",
    intent:
      "Resolve a customer support ticket\n\nTrigger: a customer opens a ticket. Outcome: the ticket is resolved and closed. Out of scope: product bug fixes tracked in engineering.",
    principals: [
      { name: "Support Agent", body: "First responder who triages and resolves customer tickets." },
      { name: "Escalation Engineer", body: "Handles tickets the agent cannot resolve." },
    ],
    actions: [
      { text: "triage the ticket", verb: "triage", actor: 0 },
      { text: "resolve the issue", verb: "resolve", actor: 0 },
      { text: "escalate to engineering", verb: "escalate", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether the agent can resolve the ticket or must escalate.",
      question: "Can the agent resolve the ticket?",
      chosen: "Resolve in tier one when possible",
      alternatives: [{ name: "resolvable → resolve" }, { name: "not resolvable → escalate" }],
    },
    initialState: "ticket opened",
    terminalStates: ["ticket closed"],
    evalText: "Confirms escalated tickets rejoin the flow and still reach a closed terminal state.",
  },
  {
    key: "recruitment",
    intent:
      "Hire a candidate\n\nTrigger: a hiring manager opens a requisition. Outcome: a candidate is hired or the requisition is closed unfilled. Out of scope: onboarding the new hire.",
    principals: [
      { name: "Recruiter", body: "Sources and screens candidates against the requisition." },
      { name: "Hiring Manager", body: "Runs interviews and makes the hiring decision." },
    ],
    actions: [
      { text: "screen the resume", verb: "screen", actor: 0 },
      { text: "interview the candidate", verb: "interview", actor: 1 },
      { text: "extend the offer", verb: "extend", actor: 0 },
    ],
    gateway: {
      decision: "Decide whether the candidate passed the interview loop.",
      question: "Did the candidate pass the interview?",
      chosen: "Extend offers to passing candidates",
      alternatives: [{ name: "passed → extend offer" }, { name: "failed → reject" }],
    },
    initialState: "requisition opened",
    terminalStates: ["candidate hired", "requisition closed unfilled"],
    evalText: "Confirms a failed interview routes to rejection, not to an offer.",
  },
  {
    key: "procure-to-pay",
    intent:
      "Pay a supplier invoice\n\nTrigger: a supplier submits an invoice against a purchase order. Outcome: the invoice is paid or disputed. Out of scope: supplier onboarding.",
    principals: [
      { name: "Procurement Officer", body: "Owns the purchase order and supplier relationship." },
      { name: "Accounts Payable Clerk", body: "Matches invoices and releases payment." },
    ],
    actions: [
      { text: "match the invoice to the purchase order", verb: "match", actor: 1 },
      { text: "approve the invoice", verb: "approve", actor: 0 },
      { text: "release the payment", verb: "release", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether the three-way match succeeds.",
      question: "Does the three-way match succeed?",
      chosen: "Pay matched invoices",
      alternatives: [{ name: "matched → pay" }, { name: "exception → dispute" }],
    },
    initialState: "invoice received",
    terminalStates: ["invoice paid", "invoice disputed"],
    evalText: "Confirms a match exception routes to dispute before any payment is released.",
  },
  {
    key: "content-publishing",
    intent:
      "Publish an article\n\nTrigger: an author submits a draft. Outcome: the article is published or archived unpublished. Out of scope: content ideation and assignment.",
    principals: [
      { name: "Author", body: "Writes the draft and revises it after review." },
      { name: "Editor", body: "Reviews drafts for quality and approves publication." },
    ],
    actions: [
      { text: "review the draft", verb: "review", actor: 1 },
      { text: "revise the article", verb: "revise", actor: 0 },
      { text: "publish the article", verb: "publish", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether the editor approves the draft for publication.",
      question: "Did the editor approve the draft?",
      chosen: "Publish approved drafts",
      alternatives: [{ name: "approved → publish" }, { name: "needs revision → return to author" }],
    },
    initialState: "draft submitted",
    terminalStates: ["article published", "article archived"],
    evalText: "Confirms a draft needing revision loops back to the author through the gateway.",
  },
  {
    key: "patient-intake",
    intent:
      "Admit a patient\n\nTrigger: a patient arrives at the clinic. Outcome: the patient is treated and discharged. Out of scope: billing and insurance claims.",
    principals: [
      { name: "Receptionist", body: "Registers arriving patients and collects intake details." },
      { name: "Triage Nurse", body: "Assesses urgency and routes the patient." },
    ],
    actions: [
      { text: "register the patient", verb: "register", actor: 0 },
      { text: "assess the urgency", verb: "assess", actor: 1 },
      { text: "discharge the patient", verb: "discharge", actor: 1 },
    ],
    gateway: {
      decision: "Decide whether the patient is an emergency or a routine visit.",
      question: "Is the visit an emergency or routine?",
      chosen: "Fast-track emergencies",
      alternatives: [{ name: "emergency → fast-track" }, { name: "routine → standard queue" }],
    },
    initialState: "patient arrived",
    terminalStates: ["patient discharged"],
    evalText:
      "Confirms emergencies are fast-tracked while routine visits enter the standard queue.",
  },
];

// ─── Suite A: no false positives on ten well-formed processes ─────────────────

describe("business-processes template — ten real-life processes (well-formed, active)", () => {
  it("seeds enforceable policies from the template", () => {
    // Sanity: the template produced a non-trivial set of deterministic +
    // probabilistic policies (the prose guidance lands as suggestions, which
    // the runner does not enforce and which we excluded above).
    expect(policies.length).toBeGreaterThanOrEqual(8);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  for (const s of SCENARIOS) {
    it(`${s.key}: every node passes the deterministic gates`, () => {
      const g = buildProcess(s, "active");
      for (const candidate of g.nodes) {
        const blocks = deterministicBlocks(evaluate(candidate, g));
        expect(
          blocks,
          `${candidate.node_type} ${candidate.id} was wrongly blocked: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
        ).toEqual([]);
      }
    });
  }

  it("queues exactly the right probabilistic checks per node type (loan-approval)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    expect(probabilisticLabels(evaluate(g.intent, g))).toEqual(
      new Set(["membership", "intent-headline", "imported-metadata"]),
    );
    expect(probabilisticLabels(evaluate(g.actions[0], g))).toEqual(
      new Set(["membership", "imported-metadata", "atomic-activity"]),
    );
    expect(probabilisticLabels(evaluate(g.gateway, g))).toEqual(
      new Set(["membership", "imported-metadata", "gateway-exhaustive"]),
    );
    // State is exempt from the membership gate (a lone milestone reads like a
    // bare state-machine stage); milestone-naming governs its quality instead.
    expect(probabilisticLabels(evaluate(g.states[0], g))).toEqual(
      new Set(["imported-metadata", "milestone-naming"]),
    );
    expect(probabilisticLabels(evaluate(g.principals[0], g))).toEqual(
      new Set(["principal-lane", "imported-metadata"]),
    );
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic blocks) ───────────

describe("business-processes template — blocks malformed processes", () => {
  it("blocks an Action with no performed_by actor", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const orphan = node(
      "action",
      "loan-approval",
      { action: "shred the file", verb: "shred" },
      "active",
    );
    // Wire serves only; omit performed_by.
    g.edges.push(edge(orphan.id, g.intent.id, "supports", "serves"));
    g.nodes.push(orphan);
    const blocks = deterministicBlocks(evaluate(orphan, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_edge_role");
    expect(blocks.some((b) => /performed_by/.test(b.reason))).toBe(true);
  });

  it("blocks a flow node (State) that does not serve any Intent", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const floating = node(
      "state",
      "loan-approval",
      { state: "in limbo", kind: "intermediate" },
      "active",
    );
    g.nodes.push(floating); // no serves edge
    const blocks = deterministicBlocks(evaluate(floating, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge_role" && /serves/.test(b.reason))).toBe(
      true,
    );
  });

  it("blocks an Eval that does not test anything", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const loose = node(
      "eval",
      "loan-approval",
      { eval: "checks something", criterion: { kind: "llm-judge" } },
      "active",
    );
    g.nodes.push(loose); // no tests edge
    const blocks = deterministicBlocks(evaluate(loose, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge_role" && /tests/.test(b.reason))).toBe(
      true,
    );
  });

  it("blocks node types outside the BPMN allowlist (Log, Idea)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    for (const t of ["log", "idea"]) {
      const stray = node(t, "loan-approval", { [t]: "stray content" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits a Rule (process guard) — Rules are allowed BPMN content", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const guard = node(
      "rule",
      "loan-approval",
      { rule: "Loans above $50k require a second underwriter sign-off." },
      "active",
    );
    expect(deterministicBlocks(evaluate(guard, g))).toEqual([]);
  });
});

// ─── Suite C: the `queued` lifecycle adaptation ───────────────────────────────

describe("business-processes template — committed-stage completeness (drafting → queued → active)", () => {
  // The same orphan Action (serves wired, performed_by missing) at three
  // lifecycles. `drafting` is the exempt sketch stage; `queued` and `active`
  // are committed and must satisfy the actor/serves wiring. Before this
  // revamp the rules fired on `["active"]` only, so a `queued` orphan slipped
  // through — closing that gap is the point of the change.
  function orphanAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildProcess(SCENARIOS[0], lifecycle);
    const orphan = node(
      "action",
      "loan-approval",
      { action: "file the paperwork", verb: "file" },
      lifecycle,
    );
    g.edges.push(edge(orphan.id, g.intent.id, "supports", "serves")); // serves wired; no performed_by
    g.nodes.push(orphan);
    return { candidate: orphan, graph: g };
  }

  it("a drafting sketch is exempt — completeness is suspended", () => {
    const { candidate, graph } = orphanAt("drafting");
    expect(deterministicBlocks(evaluate(candidate, graph))).toEqual([]);
  });

  it("a queued node IS held to completeness (the new behavior)", () => {
    const { candidate, graph } = orphanAt("queued");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some((b) => /performed_by/.test(b.reason))).toBe(true);
  });

  it("an active node IS held to completeness", () => {
    const { candidate, graph } = orphanAt("active");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some((b) => /performed_by/.test(b.reason))).toBe(true);
  });

  it("probabilistic quality checks also fire at queued, not just active", () => {
    const draftG = buildProcess(SCENARIOS[0], "drafting");
    const queuedG = buildProcess(SCENARIOS[0], "queued");
    // The intent-headline / imported-metadata checks are committed-stage only.
    expect(probabilisticLabels(evaluate(draftG.intent, draftG))).toEqual(new Set(["membership"]));
    expect(probabilisticLabels(evaluate(queuedG.intent, queuedG))).toEqual(
      new Set(["membership", "intent-headline", "imported-metadata"]),
    );
  });

  it("retiring a node skips shape gates but keeps the membership invariant", () => {
    const g = buildProcess(SCENARIOS[0], "retired");
    // A retired Action missing performed_by is NOT blocked (winding-down).
    const retiringAction = node(
      "action",
      "loan-approval",
      { action: "close the file", verb: "close" },
      "retired",
    );
    g.nodes.push(retiringAction);
    expect(deterministicBlocks(evaluate(retiringAction, g))).toEqual([]);
    // But a retired Log still violates the node-type allowlist (lifecycle-independent).
    const retiredLog = node("log", "loan-approval", { log: "did a thing" }, "retired");
    expect(
      deterministicBlocks(evaluate(retiredLog, g)).some((b) => b.sub_kind === "requires_node_type"),
    ).toBe(true);
  });
});

// ─── Suite D: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("business-processes template — end-to-end via runAuthoringPolicies", () => {
  it("blocks a Log via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "log_e2e-0",
        node_type: "log",
        doco_id: docoId,
        log: "ran the batch",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a process Intent when the judge rejects its headline", async () => {
    judge.run.mockResolvedValue({ ok: false, reason: "first line is not a brief headline" });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "intent_e2e-1",
        node_type: "intent",
        doco_id: docoId,
        intent:
          "this entire sentence is one long run-on that buries the process name and never names a trigger",
        lifecycle: "active",
      },
    });
    expect(judge.run).toHaveBeenCalled();
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.kind).toBe("probabilistic");
    expect(result.blocking?.reason).toMatch(/headline/i);
  });

  it("passes a well-formed process Intent when the judge approves", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "intent_e2e-2",
        node_type: "intent",
        doco_id: docoId,
        intent: SCENARIOS[0].intent,
        lifecycle: "active",
      },
    });
    expect(result.blocking).toBeNull();
    expect(result.violations).toEqual([]);
  });
});
