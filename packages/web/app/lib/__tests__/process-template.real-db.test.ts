// Real-life exercise of the `process` Doco template against the
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
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, 'bp-test', 'BP Test')",
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
    templateHandle: "process",
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

const deterministicWarns = (vs: Violation[]) =>
  vs.filter((v) => v.kind === "deterministic" && v.on_violation === "warn");

/** Classify a fired probabilistic check by a stable keyword in its spec. */
function probabilisticLabels(vs: Violation[]): Set<string> {
  const out = new Set<string>();
  for (const v of vs) {
    if (v.kind !== "probabilistic") continue;
    const s = v.pending_spec ?? v.reason;
    if (/belongs in process|repeatable structure/i.test(s)) out.add("membership");
    else if (/exclusiveGateway|Implementation status|Source type/i.test(s))
      out.add("imported-metadata");
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
// Edge `role` is gone: an edge's meaning comes from its `edge_type` plus its
// endpoint node types (the id prefixes), never from a `props.role` tag. The
// 4th arg is kept only as in-test documentation of what the edge MEANS (e.g.
// "serves", "performed_by") — it is NOT written into the edge, so no role leaks
// back into the data the evaluator sees.
function edge(from: string, to: string, edge_type: string, _meaning: string): EngineEdge {
  return { from_id: from, to_id: to, edge_type };
}

interface ScenarioSpec {
  key: string;
  process: string;
  principals: { name: string; body: string }[];
  actions: { text: string; verb: string; actor: number }[];
  gateway: { decision: string; question: string; chosen: string; alternatives: { name: string }[] };
  initialState: string;
  terminalStates: string[];
  evalText: string;
}

interface BuiltProcess extends Graph {
  /** The process container Action — the pool, never a member of its own pool. */
  process: CandidateFields;
  principals: CandidateFields[];
  actions: CandidateFields[];
  gateway: CandidateFields;
  states: CandidateFields[];
  evalNode: CandidateFields;
}

/** Materialize a fully-wired BPMN process at the given lifecycle. */
function buildProcess(s: ScenarioSpec, lifecycle: Lifecycle): BuiltProcess {
  // The process IS an Action — the container/pool that its members point at
  // with `has_parent`. It carries no `flows_to` (it is not a sequenced step), so
  // it is flagged `top_level_process`: the root pool has no parent and is not
  // reached by the flow, which exempts it from the membership and reachability
  // floors.
  const process = node(
    "action",
    s.key,
    { action: s.process, verb: "run", top_level_process: true },
    lifecycle,
  );
  const principals = s.principals.map((p) => node("principal", s.key, { name: p.name }, lifecycle));
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
  // The initial State is the flow's entry point: it has no incoming `flows_to`,
  // so it is flagged `entry_point` (exempt from the reachability floor) and must
  // lead somewhere — which it does, flowing to the first Action below.
  const initial = node(
    "state",
    s.key,
    { state: s.initialState, kind: "initial", entry_point: true },
    lifecycle,
  );
  // A terminal State is an exit point: the flow ends there, so it is flagged
  // `exit_point` (exempt from the "leads somewhere" floor — it has no successor)
  // while still being reached by the flow.
  const terminals = s.terminalStates.map((t) =>
    node("state", s.key, { state: t, kind: "terminal", exit_point: true }, lifecycle),
  );
  const states = [initial, ...terminals];
  const evalNode = node(
    "eval",
    s.key,
    { eval: s.evalText, criterion: { kind: "llm-judge" } },
    lifecycle,
  );

  const edges: EngineEdge[] = [];
  // Every member flow node belongs to the process via `has_parent` (→ the
  // process Action). That edge IS its pool membership.
  for (const n of [...actions, gateway, ...states])
    edges.push(edge(n.id, process.id, "has_parent", "member_of"));
  // Every member Action is `performed_by` a Principal (attributed_to).
  actions.forEach((a, i) =>
    edges.push(edge(a.id, principals[s.actions[i].actor].id, "attributed_to", "performed_by")),
  );
  // The process owner is the first Principal — the process Action is
  // `attributed_to` them (the accountable owner). This also satisfies the
  // per-Action attribution floor on the container Action itself.
  edges.push(edge(process.id, principals[0].id, "attributed_to", "owned_by"));
  // The gateway Decision is `decided_by` a Principal — the actor accountable
  // for the call (here, the process owner). Mirrors the Action performed_by
  // wiring so a well-formed gateway is never stranded in the Unassigned lane.
  edges.push(edge(gateway.id, principals[0].id, "attributed_to", "decided_by"));
  // The Eval `tests` the gateway (supports / role:tests).
  edges.push(edge(evalNode.id, gateway.id, "supports", "tests"));
  // Forward sequence flow: initial → action(s) → gateway → terminals.
  const chain = [initial, ...actions, gateway];
  for (let i = 0; i < chain.length - 1; i++)
    edges.push(edge(chain[i].id, chain[i + 1].id, "flows_to", ""));
  for (const t of terminals) edges.push(edge(gateway.id, t.id, "flows_to", ""));
  // A gateway must branch (≥2 outgoing `flows_to`). When the happy path ends
  // at a single terminal, wire the alternative as an explicit rework loop back
  // to the first Action — a BPMN-valid retry path the template allows, and it
  // gives the gateway its second branch.
  if (terminals.length < 2) edges.push(edge(gateway.id, actions[0].id, "flows_to", ""));

  const nodes = [process, ...principals, ...actions, gateway, ...states, evalNode];
  return {
    nodes,
    edges,
    principalIds: principals.map((p) => p.id),
    process,
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
    process:
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
    process:
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
    process:
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
    process:
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
    process:
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
    process:
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
    process:
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
    process:
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
    process:
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
    process:
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

describe("process template — ten real-life processes (well-formed, active)", () => {
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
    // The process container is an Action, so it queues the same probabilistic
    // checks any Action does — there is no separate Intent-shape check anymore.
    expect(probabilisticLabels(evaluate(g.process, g))).toEqual(
      new Set(["membership", "imported-metadata", "atomic-activity"]),
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

describe("process template — blocks malformed processes", () => {
  it("blocks an Action that names no performer (no attributed_to edge to a Principal)", () => {
    // With `role` gone the performer gate is requires_edge(attributed_to →
    // principal) scoped to Actions; the missing-edge reason names the edge type
    // and its target endpoint, not a `performed_by` role.
    const g = buildProcess(SCENARIOS[0], "active");
    const orphan = node(
      "action",
      "loan-approval",
      { action: "shred the file", verb: "shred" },
      "active",
    );
    // Wire serves only; omit the attributed_to → principal performer edge.
    g.edges.push(edge(orphan.id, g.process.id, "has_parent", "member_of"));
    g.nodes.push(orphan);
    const blocks = deterministicBlocks(evaluate(orphan, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_edge");
    expect(blocks.some((b) => /attributed_to.*principal/.test(b.reason))).toBe(true);
  });

  it("blocks a gateway Decision that names no decider (no attributed_to edge to a Principal)", () => {
    // Mirrors the Action performer gate: requires_edge(attributed_to →
    // principal) scoped to Decisions. The source node type (decision) is what
    // makes this attribution the gateway's decider now that roles are gone.
    const g = buildProcess(SCENARIOS[0], "active");
    const orphan = node(
      "decision",
      "loan-approval",
      {
        decision: "Decide whether the file needs a second reviewer.",
        question: "Does the file need a second reviewer?",
        chosen: "Route risky files to a second reviewer",
        alternatives: [{ name: "risky → second review" }, { name: "clear → continue" }],
      },
      "active",
    );
    // Wire serves only; omit the attributed_to → principal decider edge.
    g.edges.push(edge(orphan.id, g.process.id, "has_parent", "member_of"));
    g.nodes.push(orphan);
    const blocks = deterministicBlocks(evaluate(orphan, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_edge");
    expect(blocks.some((b) => /attributed_to.*principal/.test(b.reason))).toBe(true);
  });

  it("blocks a flow node (State) that does not belong to any process", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const floating = node(
      "state",
      "loan-approval",
      { state: "in limbo", kind: "intermediate" },
      "active",
    );
    g.nodes.push(floating); // no has_parent edge
    const blocks = deterministicBlocks(evaluate(floating, g));
    expect(
      blocks.some((b) => b.sub_kind === "requires_edge" && /has_parent.*action/.test(b.reason)),
    ).toBe(true);
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
    // The Eval gate is requires_edge(supports) with no target endpoint, so the
    // reason names only the edge type.
    const blocks = deterministicBlocks(evaluate(loose, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge" && /supports/.test(b.reason))).toBe(
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

// ─── Suite C: all flow-node gates are committed-only; drafting is exempt ───────
//
// What this suite pins down:
//   - PRINCIPAL ATTACHMENT — an Action is `performed_by`, a gateway Decision
//     `decided_by` a Principal — fires only on the committed stages, so a
//     `drafting` sketch may name no actor/decider yet.
//   - MEMBERSHIP (`has_parent`) + COMPLETENESS / SHAPE — belonging to a
//     process, forward `flows_to` wiring, gateway exhaustiveness, milestone
//     naming, … — likewise fires only on the committed stages (`queued`,
//     `active`). So a step can be drafted before its actor, decider, or parent
//     process (pool) is chosen; all are required once committed.

describe("process template — all flow-node gates committed-only, drafting exempt", () => {
  // The same orphan Action (serves wired, performer edge missing) at each
  // lifecycle. All flow-node attachment gates fire only on the committed stages,
  // so a `drafting` orphan is exempt while `queued`/`active` are blocked. With
  // `role` gone the missing-edge reason names the edge type + its target
  // endpoint, not a `performed_by` role.
  const missingPerformer = (b: Violation) => /attributed_to.*principal/.test(b.reason);
  function orphanAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildProcess(SCENARIOS[0], lifecycle);
    const orphan = node(
      "action",
      "loan-approval",
      { action: "file the paperwork", verb: "file" },
      lifecycle,
    );
    g.edges.push(edge(orphan.id, g.process.id, "has_parent", "member_of")); // serves wired; no performer edge
    g.nodes.push(orphan);
    return { candidate: orphan, graph: g };
  }

  it("a drafting flow node is NOT held to its Principal attachment (drafting exempt)", () => {
    const { candidate, graph } = orphanAt("drafting");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingPerformer)).toBe(false);
  });

  it("a queued node IS held to its Principal attachment", () => {
    const { candidate, graph } = orphanAt("queued");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingPerformer)).toBe(true);
  });

  it("an active node IS held to its Principal attachment", () => {
    const { candidate, graph } = orphanAt("active");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingPerformer)).toBe(true);
  });

  it("a drafting flow node with actor + process membership wired still has no blocks", () => {
    // has_parent + performed_by satisfied and no `flows_to` wired — the curated
    // template enforces no sequence-flow completeness, so this passes at every
    // stage. (A fully-bare draft is likewise exempt; see the orphan test above.)
    const g = buildProcess(SCENARIOS[0], "drafting");
    const attached = node(
      "action",
      "loan-approval",
      { action: "stamp the form", verb: "stamp" },
      "drafting",
    );
    g.edges.push(edge(attached.id, g.process.id, "has_parent", "member_of"));
    g.edges.push(edge(attached.id, g.principals[0].id, "attributed_to", "performed_by"));
    // No incoming/outgoing flows_to wired.
    g.nodes.push(attached);
    expect(deterministicBlocks(evaluate(attached, g))).toEqual([]);
  });

  it("a drafting flow node need NOT belong to a process (membership not required in drafting)", () => {
    // An Action that names its actor (an `attributed_to` edge to a Principal)
    // but has no `has_parent` edge to a process is fine while drafting — the
    // membership link is deferrable until it commits.
    const g = buildProcess(SCENARIOS[0], "drafting");
    const noParent = node(
      "action",
      "loan-approval",
      { action: "stamp the form", verb: "stamp" },
      "drafting",
    );
    g.edges.push(edge(noParent.id, g.principals[0].id, "attributed_to", "performed_by")); // actor only; no has_parent
    g.nodes.push(noParent);
    const blocks = deterministicBlocks(evaluate(noParent, g));
    expect(blocks.some((b) => /has_parent.*action/.test(b.reason))).toBe(false);
    expect(blocks).toEqual([]);

    // A milestone State (whose only attachment gate is the membership link)
    // likewise needs no process while drafting.
    const draftState = node(
      "state",
      "loan-approval",
      { state: "paperwork stamped", kind: "intermediate" },
      "drafting",
    );
    g.nodes.push(draftState); // no has_parent edge
    expect(deterministicBlocks(evaluate(draftState, g))).toEqual([]);
  });

  it("the same unattached flow node IS blocked once committed (queued)", () => {
    // The membership link is required at the committed stages — the drafting
    // exemption above is lifecycle-scoped, not a blanket drop of the gate.
    const g = buildProcess(SCENARIOS[0], "queued");
    const noParent = node(
      "action",
      "loan-approval",
      { action: "stamp the form", verb: "stamp" },
      "queued",
    );
    g.edges.push(edge(noParent.id, g.principals[0].id, "attributed_to", "performed_by"));
    g.edges.push(edge(g.states[0].id, noParent.id, "flows_to", ""));
    g.edges.push(edge(noParent.id, g.gateway.id, "flows_to", ""));
    g.nodes.push(noParent);
    const blocks = deterministicBlocks(evaluate(noParent, g));
    expect(
      blocks.some((b) => b.sub_kind === "requires_edge" && /has_parent.*action/.test(b.reason)),
    ).toBe(true);
  });

  it("a gateway Decision's decider edge is enforced at queued and active, NOT drafting", () => {
    // Mirrors the performer gate: a committed gateway must name its decider
    // Principal, so a missing `attributed_to` edge to a Principal blocks at
    // `queued`/`active`, but a `drafting` sketch may defer it. With `role` gone
    // the decider is just the gateway Decision's `attributed_to` → principal.
    function gatewayMissingDeciderBlocks(lifecycle: Lifecycle): boolean {
      const g = buildProcess(SCENARIOS[0], lifecycle);
      const orphan = node(
        "decision",
        "loan-approval",
        {
          decision: "Decide whether to escalate the application.",
          question: "Should the application be escalated?",
          chosen: "Escalate high-risk applications",
          alternatives: [{ name: "high risk → escalate" }, { name: "low risk → continue" }],
        },
        lifecycle,
      );
      g.edges.push(edge(orphan.id, g.process.id, "has_parent", "member_of")); // serves wired; no decider edge
      g.nodes.push(orphan);
      return deterministicBlocks(evaluate(orphan, g)).some((b) =>
        /attributed_to.*principal/.test(b.reason),
      );
    }
    expect(
      gatewayMissingDeciderBlocks("drafting"),
      "drafting is exempt from the decider rule",
    ).toBe(false);
    expect(gatewayMissingDeciderBlocks("queued"), "queued is held to the decider rule").toBe(true);
    expect(gatewayMissingDeciderBlocks("active"), "active is held to the decider rule").toBe(true);
  });

  it("probabilistic quality checks also fire at queued, not just active", () => {
    const draftG = buildProcess(SCENARIOS[0], "drafting");
    const queuedG = buildProcess(SCENARIOS[0], "queued");
    // The imported-metadata / atomic-activity checks are committed-stage only;
    // the soft membership gate fires at every stage.
    expect(probabilisticLabels(evaluate(draftG.process, draftG))).toEqual(new Set(["membership"]));
    expect(probabilisticLabels(evaluate(queuedG.process, queuedG))).toEqual(
      new Set(["membership", "imported-metadata", "atomic-activity"]),
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

describe("process template — end-to-end via runAuthoringPolicies", () => {
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

  it("blocks a node when a blocking probabilistic check is rejected by the judge", async () => {
    // The imported-metadata judge (a blocking probabilistic) fires on a
    // committed Principal. A bare Principal carries no deterministic block
    // (its coverage gate is a warn), so a judge rejection is what blocks.
    judge.run.mockResolvedValue({
      ok: false,
      reason: "exposes imported BPMN/source metadata in visible prose",
    });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "principal_e2e-1",
        node_type: "principal",
        doco_id: docoId,
        name: "Loan Officer",
        lifecycle: "active",
      },
    });
    expect(judge.run).toHaveBeenCalled();
    expect(result.blocking).not.toBeNull();
    expect(result.blocking?.kind).toBe("probabilistic");
  });

  it("passes a node when the judge approves (only advisory warns remain)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "principal_e2e-2",
        node_type: "principal",
        doco_id: docoId,
        name: "Loan Officer",
        lifecycle: "active",
      },
    });
    // Not blocked. With the judge approving every probabilistic check, the bare
    // synthetic Principal trips nothing — the curated set has no deterministic
    // warn for an idle Principal (the actor-coverage gate was dropped).
    expect(result.blocking).toBeNull();
    expect(result.violations.every((v) => v.on_violation === "warn")).toBe(true);
  });
});

// ─── Suite E: structural gates trip no false-positive warnings ────────────────
//
// The curated template's remaining deterministic gates are the node-/edge-type
// allowlists, the actor-attribution floor, the `has_parent` membership floor +
// ceiling, the gateway branch-count floor, and milestone-name uniqueness. Suite
// A proves the ten well-formed processes pass every BLOCK gate; here we also
// prove a well-formed committed process trips no deterministic WARNING.

describe("process template — new structural gates (no false positives)", () => {
  for (const s of SCENARIOS) {
    it(`${s.key}: a well-formed committed process trips no deterministic warnings`, () => {
      const g = buildProcess(s, "active");
      for (const candidate of g.nodes) {
        const warns = deterministicWarns(evaluate(candidate, g));
        expect(
          warns,
          `${candidate.node_type} ${candidate.id} wrongly warned: ${warns.map((w) => `${w.sub_kind}: ${w.reason}`).join("; ")}`,
        ).toEqual([]);
      }
    });
  }
});

describe("process template — unique milestone names", () => {
  it("blocks a second committed State that reuses a milestone name", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const dupName = g.states[0].state as string;
    const dup = node("state", "loan-approval", { state: dupName, kind: "intermediate" }, "active");
    g.nodes.push(dup);
    const blocks = deterministicBlocks(evaluate(dup, g));
    expect(blocks.some((b) => b.sub_kind === "unique_field" && /state/.test(b.reason))).toBe(true);
  });
});

describe("process template — gateway branch count", () => {
  it("blocks a single-exit gateway Decision", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const stub = node(
      "decision",
      "loan-approval",
      {
        decision: "Decide whether to proceed.",
        question: "Proceed?",
        chosen: "proceed",
        alternatives: [{ name: "yes" }, { name: "no" }],
      },
      "active",
    );
    g.edges.push(edge(stub.id, g.process.id, "has_parent", "member_of"));
    g.edges.push(edge(g.actions[0].id, stub.id, "flows_to", "")); // one incoming
    g.edges.push(edge(stub.id, g.states[1].id, "flows_to", "")); // a single outgoing branch
    g.nodes.push(stub);
    const blocks = deterministicBlocks(evaluate(stub, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge" && /flows_to/.test(b.reason))).toBe(
      true,
    );
  });
});

describe("process template — top-level-process and entry-point flags", () => {
  // The `has_parent` membership floor is excused ONLY by the explicit
  // `top_level_process` flag (the structural incoming-`has_parent` exemption is
  // gone). The `entry_point` flag is a separate, sequence-flow concept: it
  // excuses a node from the reachability floor (no incoming `flows_to` needed)
  // but obliges it to LEAD somewhere (≥1 outgoing `flows_to`).
  it("a top_level_process Action with no parent is NOT blocked by the membership floor (committed)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const root = node(
      "action",
      "loan-approval",
      { action: "run a sub-process", verb: "run", top_level_process: true, entry_point: true },
      "active",
    );
    // Attribute it so per-step attribution can't fire; it leads somewhere so the
    // entry-point "leads somewhere" floor is satisfied; it has no parent on purpose.
    g.edges.push(edge(root.id, g.principals[0].id, "attributed_to", "owned_by"));
    g.edges.push(edge(root.id, g.actions[0].id, "flows_to", ""));
    g.nodes.push(root); // deliberately NO has_parent edge
    const blocks = deterministicBlocks(evaluate(root, g));
    expect(
      blocks,
      `top_level_process Action wrongly blocked: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
    ).toEqual([]);
  });

  it("an ordinary committed Action with no parent and no flag IS still blocked (membership)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const orphan = node(
      "action",
      "loan-approval",
      { action: "intake the application", verb: "intake" },
      "active",
    );
    g.edges.push(edge(orphan.id, g.principals[0].id, "attributed_to", "performed_by"));
    g.edges.push(edge(g.actions[0].id, orphan.id, "flows_to", "")); // reachable, so only membership can fire
    g.nodes.push(orphan); // no has_parent, no top_level_process flag
    const blocks = deterministicBlocks(evaluate(orphan, g));
    expect(
      blocks.some((b) => b.sub_kind === "requires_edge" && /has_parent.*action/.test(b.reason)),
    ).toBe(true);
  });

  it("a non-entry committed flow node with no incoming flows_to is blocked (reachability)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const stranded = node(
      "action",
      "loan-approval",
      { action: "reconcile the ledger", verb: "reconcile" },
      "active",
    );
    g.edges.push(edge(stranded.id, g.process.id, "has_parent", "member_of")); // belongs to the pool
    g.edges.push(edge(stranded.id, g.principals[0].id, "attributed_to", "performed_by"));
    g.edges.push(edge(stranded.id, g.states[1].id, "flows_to", "")); // leads somewhere, but nothing reaches it
    g.nodes.push(stranded); // no incoming flows_to, not an entry point
    const blocks = deterministicBlocks(evaluate(stranded, g));
    expect(
      blocks.some(
        (b) => b.sub_kind === "requires_edge" && /incoming.*flows_to|flows_to.*from/.test(b.reason),
      ),
      `expected a reachability block; got: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
    ).toBe(true);
  });

  it("a committed flow node with no OUTGOING flows_to is blocked (must lead somewhere)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const deadEnd = node(
      "action",
      "loan-approval",
      { action: "file the paperwork", verb: "file" },
      "active",
    );
    g.edges.push(edge(deadEnd.id, g.process.id, "has_parent", "member_of"));
    g.edges.push(edge(deadEnd.id, g.principals[0].id, "attributed_to", "performed_by"));
    g.edges.push(edge(g.actions[0].id, deadEnd.id, "flows_to", "")); // reachable, so only "leads somewhere" can fire
    g.nodes.push(deadEnd); // flows nowhere, and it is NOT an exit point
    const blocks = deterministicBlocks(evaluate(deadEnd, g));
    expect(
      blocks.some((b) => b.sub_kind === "requires_edge" && /flows_to/.test(b.reason)),
      `expected a "leads somewhere" block; got: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
    ).toBe(true);
  });

  it("an exit_point flow node with no OUTGOING flows_to is NOT blocked (it is an end)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    const ending = node(
      "state",
      "loan-approval",
      { state: "Closed", kind: "terminal", exit_point: true },
      "active",
    );
    g.edges.push(edge(ending.id, g.process.id, "has_parent", "member_of"));
    g.edges.push(edge(g.actions[0].id, ending.id, "flows_to", "")); // reached by the flow
    g.nodes.push(ending); // exit point, flows nowhere — and that is allowed
    const blocks = deterministicBlocks(evaluate(ending, g));
    expect(
      blocks,
      `exit point wrongly blocked: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
    ).toEqual([]);
  });
});

// ─── Suite G: a flow node belongs to AT MOST one process (membership ceiling) ──
//
// The membership FLOOR (≥1 process) gets a matching CEILING (≤1): every
// committed flow node belongs to exactly one BPMN pool. Like the floor, the
// ceiling fires on the committed stages only (`queued`, `active`) — a
// `drafting` sketch is exempt. Suite A already proves the ten well-formed
// processes (one has_parent per member) pass every block gate; here we add the
// explicit ceiling check and prove it catches a committed node wired into two
// processes, while a drafting one is left alone.

describe("process template — a flow node belongs to at most one process", () => {
  it("seeds the limits_edge membership ceiling (has_parent → action), firing on committed stages only", () => {
    const ceiling = policies.find(
      (p) =>
        isDeterministicPredicate(p.predicate) &&
        p.predicate.sub_kind === "limits_edge" &&
        p.predicate.edge_type === "has_parent" &&
        p.predicate.target_node_type === "action",
    );
    expect(ceiling).toBeDefined();
    expect(ceiling?.on_violation).toBe("block");
    expect(ceiling?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
  });

  // Wire a SECOND process Action into the Doco, then a member Action whose
  // `has_parent` points at BOTH it and the original process — the ambiguous
  // two-pool case.
  function actionInTwoProcesses(lifecycle: Lifecycle): {
    candidate: CandidateFields;
    graph: BuiltProcess;
  } {
    const g = buildProcess(SCENARIOS[0], lifecycle);
    const second = node(
      "action",
      "loan-servicing",
      { action: "Service a disbursed loan", verb: "run" },
      lifecycle,
    );
    const twoPool = node(
      "action",
      "loan-approval",
      { action: "reconcile the ledger", verb: "reconcile" },
      lifecycle,
    );
    g.edges.push(edge(twoPool.id, g.process.id, "has_parent", "member_of"));
    g.edges.push(edge(twoPool.id, second.id, "has_parent", "member_of"));
    // Attach a performing Principal so the failure is unambiguously the ceiling,
    // not the performed_by floor.
    g.edges.push(edge(twoPool.id, g.principals[0].id, "attributed_to", "performed_by"));
    g.nodes.push(second, twoPool);
    return { candidate: twoPool, graph: g };
  }

  for (const lifecycle of ["queued", "active"] as const) {
    it(`blocks an Action belonging to two processes at ${lifecycle}`, () => {
      const { candidate, graph } = actionInTwoProcesses(lifecycle);
      const blocks = deterministicBlocks(evaluate(candidate, graph));
      expect(
        blocks.some((b) => b.sub_kind === "limits_edge" && /has_parent.*action/.test(b.reason)),
        `${lifecycle}: expected the membership ceiling to block, got: ${blocks.map((b) => `${b.sub_kind}: ${b.reason}`).join("; ")}`,
      ).toBe(true);
    });
  }

  it("does NOT block an Action in two processes while it is a drafting sketch", () => {
    const { candidate, graph } = actionInTwoProcesses("drafting");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(
      blocks.some((b) => b.sub_kind === "limits_edge" && /has_parent.*action/.test(b.reason)),
    ).toBe(false);
  });

  it("does NOT block flow nodes that each belong to exactly one process (no false positive)", () => {
    const g = buildProcess(SCENARIOS[0], "active");
    for (const candidate of [g.actions[0], g.gateway, g.states[0]]) {
      const blocks = deterministicBlocks(evaluate(candidate, g));
      expect(
        blocks.some((b) => b.sub_kind === "limits_edge"),
        `${candidate.node_type} ${candidate.id} wrongly tripped the membership ceiling`,
      ).toBe(false);
    }
  });
});
