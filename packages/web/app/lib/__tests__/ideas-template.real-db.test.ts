// Real-life exercise of the `ideas` Doco template against the REAL authoring
// stack — the template definition (`@doco/host` DEFAULT_DOCO_TEMPLATES), the
// host seam that seeds a Doco's `policies` from it (`createDocoInWorkspace`,
// against in-process PGlite loaded with the real schema.sql), and the pure
// authoring evaluator (`@doco/shared`), driven exactly as
// `authoring-runner.server` drives it. The only stubbed boundary is the LLM
// judge (Suite E), which can't run offline.
//
// FIFTY real-life ideas form the corpus (Suite A) — feature requests,
// integrations, pricing and packaging, growth experiments, UX fixes, AI bets,
// internal-platform proposals, hardware changes, partnerships, moonshots, and
// one duplicate — spread across ten product domains and across the whole
// funnel: inbox jots, parked notes, triaged and in-evaluation ideas, and
// closed ones (promoted or rejected with a reason). If the template
// false-positives on any well-formed idea, that is a defect. Suites B–E then
// prove it catches real modeling mistakes (a committed idea with no `problem`
// or no owner, an idea pinned to two opportunities, a dangling assessment,
// off-template node types), implements the drafting/inbox exemption, guards
// the edge-type allowlist, and wires the checks end-to-end through the runner.
// The `problem` gate is the one that matters most to prove end-to-end: it
// reads a field that lives in the node's `extra` bag, so this test confirms
// the whole seed → flatten → evaluate path.

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

const WORKSPACE_ID = "workspace_01IDEATEST00000000000001";
const USER_ID = "user_01IDEATEST000000000000001";

let docoId = "";
/** Deterministic + probabilistic policies seeded from the template (suggestions excluded, mirroring the runner). */
let policies: LoadedPolicy[] = [];

// ─── seeding ────────────────────────────────────────────────────────────────

async function seedWorkspaceAndUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'idea-tester','{}')", [
    USER_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, 'idea-test', 'Ideas')",
    [WORKSPACE_ID],
  );
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
  dbm.db = new PGlite();
  await dbm.db.exec(schemaSql);
  await seedWorkspaceAndUser();
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "idea-tracker",
    createdByUserId: USER_ID,
    templateHandle: "ideas",
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
    if (/belongs in an idea tracker/i.test(s)) out.add("membership");
    else if (/restates the proposal/i.test(s)) out.add("idea-quality");
    else if (/assessment/i.test(s)) out.add("assessment-quality");
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

/**
 * Where an idea sits in the funnel. Maps onto the node lifecycle:
 * inbox/parked → drafting, triaged → queued, evaluating → active,
 * promoted/rejected → retired (with the disposition on the node).
 */
type Stage = "inbox" | "parked" | "triaged" | "evaluating" | "promoted" | "rejected";

const STAGE_LIFECYCLE: Record<Stage, Lifecycle> = {
  inbox: "drafting",
  parked: "drafting",
  triaged: "queued",
  evaluating: "active",
  promoted: "retired",
  rejected: "retired",
};

interface IdeaSpec {
  /** The proposal — what to build or change, in one concrete pitch. */
  prose: string;
  /** The user/business problem behind it, in the proposer's words. */
  problem?: string;
  /** Label of the opportunity (Intent) this idea serves. */
  opportunity?: string;
  stage: Stage;
  /** Each repeated request for the same idea — the demand stream (Logs). */
  demand?: { prose: string; happened_at: string }[];
  /** Feedback quotes, research, data behind the idea (References). */
  evidence?: { label: string; locator: string }[];
  /** A scoring pass or validation experiment (Eval, supports the idea). */
  assessment?: { prose: string; last_status: "pass" | "fail" | "pending" };
  /** Where it went when picked up (set on a promoted idea). */
  promoted_to?: string;
  /** Why it was rejected — or, on a parked idea, what would revive it. */
  rejection_reason?: string;
  /** Index of another idea in the same portfolio this one relates to. */
  related?: number;
  /** Index of the canonical idea this entry duplicates (this one retired, replaced). */
  duplicateOf?: number;
}

interface PortfolioSpec {
  key: string;
  owner: { name: string };
  ideas: IdeaSpec[];
}

interface BuiltPortfolio extends Graph {
  owner: CandidateFields;
  ideas: CandidateFields[];
  opportunities: CandidateFields[];
  assessments: CandidateFields[];
}

/**
 * Materialize a portfolio: owner Principal + opportunity Intents + idea nodes
 * + demand Logs + evidence References + assessment Evals + edges. Committed
 * (queued/active) ideas are wired the way the template's discipline says a
 * triaged idea should be: a `problem`, an owner, and their target opportunity.
 * Inbox/parked drafting jots may omit all three; retired ideas carry their
 * disposition.
 */
function buildPortfolio(s: PortfolioSpec): BuiltPortfolio {
  const owner = node("principal", s.key, { name: s.owner.name }, "active");
  const opportunities = new Map<string, CandidateFields>();
  for (const it of s.ideas) {
    if (it.opportunity && !opportunities.has(it.opportunity)) {
      opportunities.set(it.opportunity, node("intent", s.key, { prose: it.opportunity }, "active"));
    }
  }
  const ideas: CandidateFields[] = [];
  const assessments: CandidateFields[] = [];
  const rest: CandidateFields[] = [];
  const edges: EngineEdge[] = [];

  s.ideas.forEach((it, i) => {
    const lifecycle = STAGE_LIFECYCLE[it.stage];
    const idea = node(
      "idea",
      s.key,
      {
        prose: it.prose,
        ...(it.problem ? { problem: it.problem } : {}),
        ...(it.promoted_to ? { promoted_to: it.promoted_to } : {}),
        ...(it.rejection_reason ? { rejection_reason: it.rejection_reason } : {}),
      },
      lifecycle,
    );
    ideas.push(idea);

    // A committed or closed idea names its shepherd; an inbox jot may not.
    if (it.stage !== "inbox" && it.stage !== "parked") {
      edges.push(edge(idea.id, owner.id, "attributed_to"));
    }
    // The opportunity it serves (its home in the opportunity tree).
    if (it.opportunity) {
      const opp = opportunities.get(it.opportunity);
      if (opp) edges.push(edge(idea.id, opp.id, "has_parent"));
    }
    if (it.related != null && ideas[it.related]) {
      edges.push(edge(idea.id, ideas[it.related].id, "relates_to"));
    }
    // A duplicate: the canonical idea replaces it.
    if (it.duplicateOf != null && ideas[it.duplicateOf]) {
      edges.push(edge(ideas[it.duplicateOf].id, idea.id, "replaces"));
    }
    // The demand stream: every repeated request is a Log supporting the idea,
    // and the idea is derived from the request that sparked it.
    (it.demand ?? []).forEach((d, j) => {
      const log = node(
        "log",
        s.key,
        { prose: d.prose, happened_at: d.happened_at, verb: "requested" },
        "active",
      );
      rest.push(log);
      edges.push(edge(log.id, idea.id, "supports"));
      if (j === 0) edges.push(edge(idea.id, log.id, "derived_from"));
    });
    // Evidence: feedback, research, data — References supporting the idea.
    for (const ev of it.evidence ?? []) {
      const ref = node("reference", s.key, { prose: ev.label, locator: ev.locator }, "active");
      rest.push(ref);
      edges.push(edge(ref.id, idea.id, "supports"));
    }
    // The assessment that scored or validated it.
    if (it.assessment) {
      const ev = node(
        "eval",
        s.key,
        { prose: it.assessment.prose, last_status: it.assessment.last_status },
        "active",
      );
      assessments.push(ev);
      edges.push(edge(ev.id, idea.id, "supports"));
    }
  });

  return {
    nodes: [owner, ...opportunities.values(), ...ideas, ...assessments, ...rest],
    edges,
    principalIds: [owner.id],
    owner,
    ideas,
    opportunities: [...opportunities.values()],
    assessments,
  };
}

// ─── the fifty real-life ideas, across ten portfolios ──────────────────────────

const PORTFOLIOS: PortfolioSpec[] = [
  {
    key: "saas-collab",
    owner: { name: "Product Lead, Workspaces" },
    ideas: [
      {
        prose:
          "Add SAML single sign-on so enterprise IT can provision and revoke access centrally.",
        problem:
          "Security teams at 100+ seat prospects refuse per-user passwords; three enterprise deals stalled in procurement over missing SSO.",
        opportunity: "Make the product enterprise-ready so security review stops killing deals",
        stage: "promoted",
        promoted_to: "intent_01HSSOENTERPRISEBET000001",
        evidence: [
          {
            label: "Lost-deal notes: SSO cited in 3 of 5 enterprise losses this quarter",
            locator: "doc://sales/lost-deal-review-q1",
          },
        ],
      },
      {
        prose:
          "Granular role permissions: let admins scope contractors to single projects with view-only access.",
        problem:
          "Agency admins onboard external contractors but can only grant workspace-wide access, so they either over-share client data or manage exports by hand.",
        opportunity: "Make the product enterprise-ready so security review stops killing deals",
        stage: "evaluating",
        demand: [
          {
            prose: "Acme Agency asked for contractor-scoped roles during onboarding call.",
            happened_at: "2026-04-02T10:00:00Z",
          },
          {
            prose: "Support ticket #4821: 'how do I stop a freelancer seeing other clients?'",
            happened_at: "2026-05-11T09:30:00Z",
          },
        ],
        assessment: {
          prose:
            "ICE scoring pass: impact 8 (unblocks agency segment), confidence 7 (12 independent requests), ease 4 (permissions rework). Score 19/30 — proceed to design spike.",
          last_status: "pass",
        },
      },
      {
        prose:
          "Self-serve audit-log export (CSV + API) covering sign-ins, permission changes, and document access.",
        problem:
          "Compliance reviewers at regulated customers ask for activity evidence during annual audits; today support assembles it by hand in about two days per request.",
        opportunity: "Make the product enterprise-ready so security review stops killing deals",
        stage: "triaged",
        evidence: [
          {
            label: "Support macro usage: 14 manual audit-export requests in the last 90 days",
            locator: "https://support.example.com/macros/audit-export",
          },
        ],
      },
      {
        prose: "Teamspace roles with per-folder guest access for outside collaborators.",
        problem:
          "Admins can't restrict outside collaborators to one client folder without giving them everything.",
        opportunity: "Make the product enterprise-ready so security review stops killing deals",
        stage: "rejected",
        rejection_reason:
          "Duplicate of the granular role permissions idea — folded its per-folder wording into that record; demand consolidated there.",
        duplicateOf: 1,
      },
      {
        prose:
          "Native Slack notifications: post doc comments and mentions into a channel the team picks.",
        problem:
          "Teams living in Slack miss review requests for hours because email notifications are muted, so reviews stall.",
        opportunity: "Help new teams reach their first shared win in week one",
        stage: "promoted",
        promoted_to: "intent_01HSLACKLOOPBET0000000001",
      },
      {
        prose:
          "Bulk CSV import that maps legacy wiki pages into docs with authors and dates preserved.",
        problem:
          "New teams arriving from legacy wikis face re-creating hundreds of pages by hand, so trials stall before the team ever works in the product.",
        opportunity: "Help new teams reach their first shared win in week one",
        stage: "triaged",
        demand: [
          {
            prose: "Trial exit survey: 'couldn't bring our old wiki over' (9 mentions in March).",
            happened_at: "2026-03-28T16:00:00Z",
          },
        ],
      },
    ],
  },
  {
    key: "fitness-app",
    owner: { name: "Growth PM, Engagement" },
    ideas: [
      {
        prose:
          "Streak freeze: one earned token per week that auto-covers a missed day before the streak resets.",
        problem:
          "Users who break a 30+ day streak open the app 60% less the following week — one missed day undoes a month of habit-building.",
        opportunity: "Keep habit momentum through life's interruptions",
        stage: "evaluating",
        assessment: {
          prose:
            "Two-week holdout experiment on 5% of streak-holders: day-7 return rate after a missed day rose from 41% to 58% with a freeze token. Recommend: persevere and ship to all.",
          last_status: "pass",
        },
      },
      {
        prose:
          "Workout buddy matching: pair users with similar schedules and goals for mutual accountability.",
        problem:
          "Interviewees who quit said exercising alone made skipping painless; those with a partner reported showing up on days they didn't feel like it.",
        opportunity: "Make motivation social instead of solitary",
        stage: "triaged",
        evidence: [
          {
            label: "Churn-interview synthesis: accountability gap named in 11 of 18 interviews",
            locator: "doc://research/churn-interviews-2026-04",
          },
        ],
      },
      {
        prose: "Standalone Apple Watch mode: track a run without the phone present.",
        problem:
          "Runners don't want to carry a phone; app-store reviews mention phone-free runs as the reason for switching to a competitor.",
        opportunity: "Keep habit momentum through life's interruptions",
        stage: "evaluating",
        demand: [
          {
            prose: "App-store review (4★): 'I'd give 5 stars if I could leave my phone home.'",
            happened_at: "2026-05-02T08:00:00Z",
          },
          {
            prose: "Community thread '+1 standalone watch' reached 240 upvotes.",
            happened_at: "2026-05-20T12:00:00Z",
          },
        ],
      },
      {
        prose: "Dark mode across workout and stats screens.",
        problem:
          "Evening exercisers report the white stats screen is blinding between sets in dim gyms, and some say they avoid opening the app at night.",
        opportunity: "Keep habit momentum through life's interruptions",
        stage: "promoted",
        promoted_to: "intent_01HDARKMODEBET00000000001",
      },
      {
        prose:
          "AI form-check: use the phone camera to flag squat and deadlift form issues in real time.",
        stage: "inbox",
      },
    ],
  },
  {
    key: "marketplace",
    owner: { name: "Marketplace PM, Trust" },
    ideas: [
      {
        prose:
          "Verified-pro badge backed by license and background checks, shown on search results.",
        problem:
          "First-time buyers say they can't tell a reliable provider from a risky one, and 'how do I know they're legit' is the top pre-booking support question.",
        opportunity: "Make a stranger feel safe to book in one visit",
        stage: "evaluating",
        assessment: {
          prose:
            "Painted-door test: badge filter shown to 10% of searchers; 23% used it and badged listings converted 1.8x. Verdict: validated, scope the verification pipeline.",
          last_status: "pass",
        },
      },
      {
        prose: "Instant-book for repeat customers, skipping the quote round-trip entirely.",
        problem:
          "Returning customers re-request quotes from providers they already trust; the median rebooking takes 26 hours of back-and-forth for a known job.",
        opportunity: "Cut booking friction for jobs we already understand",
        stage: "triaged",
      },
      {
        prose: "Provider video intros on profile pages: a 30-second self-introduction clip.",
        stage: "inbox",
      },
      {
        prose: "Escrow payments: hold funds until the buyer confirms the job is done.",
        problem:
          "Payment disputes are 31% of support volume and providers churn citing no-pay jobs; both sides want a neutral middle.",
        opportunity: "Make a stranger feel safe to book in one visit",
        stage: "promoted",
        promoted_to: "intent_01HESCROWBET0000000000001",
      },
      {
        prose: "Surge pricing tooling so providers can auto-raise rates in peak weeks.",
        problem:
          "Peak-season demand outstrips supply and jobs go unfilled while providers manually fiddle with rates.",
        opportunity: "Cut booking friction for jobs we already understand",
        stage: "rejected",
        rejection_reason:
          "Tested poorly: buyers read surge pricing as gouging (trust score -18% in the concept test), which works against the trust opportunity that anchors this marketplace. Revisit only as transparent 'busy-season rates' published ahead of time.",
      },
    ],
  },
  {
    key: "devtools",
    owner: { name: "DX Lead, Platform" },
    ideas: [
      {
        prose:
          "Interactive API playground inside the docs: run real calls against a sandbox without leaving the page.",
        problem:
          "45% of new developers never make a first API call; funnel analysis shows they drop off between reading the docs and configuring a client.",
        opportunity: "Get a developer to a working first call in their first session",
        stage: "evaluating",
        assessment: {
          prose:
            "Prototype playground on the two highest-traffic doc pages: first-call completion for visitors who used it was 71% vs 44% baseline. Verdict: pass — expand to all endpoint pages.",
          last_status: "pass",
        },
      },
      {
        prose:
          "Webhook inspector with capture-and-replay so developers can debug deliveries against their local stack.",
        problem:
          "Webhook debugging is blind: developers can't see what we sent or replay a failed delivery, so integration bugs take days of support back-and-forth to diagnose.",
        opportunity: "Let developers see and fix their own integration failures",
        stage: "triaged",
        demand: [
          {
            prose: "Forum: 'how do I replay webhook event evt_8231?' — fifth ask this month.",
            happened_at: "2026-05-18T11:00:00Z",
          },
        ],
      },
      {
        prose: "Official Terraform provider for managing projects, keys, and webhooks as code.",
        problem:
          "Platform teams standardizing on IaC can't adopt us without hand-rolled scripts; two enterprise platform teams named it a blocker this quarter.",
        opportunity: "Let developers see and fix their own integration failures",
        stage: "triaged",
        demand: [
          {
            prose: "GitHub issue 'Terraform provider?' crossed 90 reactions.",
            happened_at: "2026-04-15T09:00:00Z",
          },
          {
            prose: "Enterprise prospect platform team asked for Terraform in security review.",
            happened_at: "2026-05-29T15:00:00Z",
          },
        ],
      },
      {
        prose: "Sandbox tenant pre-seeded with synthetic data for safe experimentation.",
        stage: "inbox",
      },
      {
        prose: "CLI scaffold command that generates a working starter app wired to your keys.",
        problem:
          "Developers copy boilerplate from four doc pages to reach a running app; hackathon feedback called setup 'death by snippets'.",
        opportunity: "Get a developer to a working first call in their first session",
        stage: "promoted",
        promoted_to: "intent_01HCLISCAFFOLDBET00000001",
        related: 0,
      },
    ],
  },
  {
    key: "fintech",
    owner: { name: "Payments PM, SMB" },
    ideas: [
      {
        prose:
          "Multi-currency invoicing: issue in the client's currency with automatic FX at payment time.",
        problem:
          "Exporting SMBs invoice in EUR but reconcile in USD by hand; sales lost two cross-border prospects over double-entry bookkeeping pain.",
        opportunity: "Make cross-border money movement boring and exact",
        stage: "evaluating",
      },
      {
        prose:
          "Cash-flow forecast: project the next 90 days from invoice due dates and recurring bills.",
        problem:
          "Owner-operators discover shortfalls when the account is already short — they have receivables data but no forward view of it.",
        opportunity: "Give owners a forward view of their cash",
        stage: "triaged",
        evidence: [
          {
            label: "Interview synthesis: 9 of 14 owners keep a shadow cash spreadsheet",
            locator: "doc://research/smb-cash-interviews",
          },
        ],
      },
      {
        prose: "Receipt-scan expense capture: photograph a receipt, get a categorized expense.",
        problem:
          "Manual expense entry is the most-abandoned flow in the product (62% drop-off), and owners batch receipts quarterly with an accountant instead.",
        opportunity: "Give owners a forward view of their cash",
        stage: "promoted",
        promoted_to: "intent_01HRECEIPTSCANBET00000001",
      },
      {
        prose: "Crypto payouts: let merchants withdraw their balance as stablecoins.",
        problem:
          "A handful of community members asked to hold balances in stablecoins instead of local currency.",
        opportunity: "Make cross-border money movement boring and exact",
        stage: "rejected",
        rejection_reason:
          "Thin demand (6 requests, none from the core SMB segment) against heavy regulatory and licensing load in every market we operate; does not serve the cross-border opportunity better than local rails. Re-open only if core-segment demand materializes.",
      },
      {
        prose: "Same-day payout tier (paid) for merchants who need today's takings tonight.",
        problem:
          "Cash-tight merchants churn to providers with faster settlement; exit surveys rank payout speed above fees.",
        opportunity: "Make cross-border money movement boring and exact",
        stage: "evaluating",
        assessment: {
          prose:
            "Willingness-to-pay test on the pricing page: 18% of eligible merchants clicked the same-day option at a 1% fee. Above the 12% bar set in the criteria rule — validated; modeling float cost next.",
          last_status: "pass",
        },
      },
    ],
  },
  {
    key: "ecommerce",
    owner: { name: "Merchant Success Lead" },
    ideas: [
      {
        prose: "One-page checkout theme with address autocomplete and a single pay button.",
        problem:
          "Merchants on the three-step checkout see 68% cart abandonment on mobile versus the 55% industry median; each extra step sheds buyers.",
        opportunity: "Recover the sales merchants lose at checkout",
        stage: "triaged",
        evidence: [
          {
            label: "Checkout funnel benchmark across 1,200 storefronts",
            locator: "doc://analytics/checkout-benchmark-2026",
          },
        ],
      },
      {
        prose: "Branded post-purchase tracking page with delivery ETA pulled from the carrier.",
        problem:
          "'Where is my order?' is 38% of merchants' support volume; buyers email because the only tracking link is a raw carrier page.",
        opportunity: "Make the after-purchase experience self-serve",
        stage: "promoted",
        promoted_to: "intent_01HTRACKPAGEBET0000000001",
      },
      {
        prose:
          "AI product-description writer that drafts copy from a photo and three bullet points.",
        problem:
          "Long-tail merchants list slowly because writing copy is the chore they defer — median 11 days from photo upload to published listing.",
        opportunity: "Recover the sales merchants lose at checkout",
        stage: "evaluating",
        assessment: {
          prose:
            "Concierge test with 20 merchants: drafts accepted with light edits 70% of the time, listing time cut from days to hours. Pending: quality bar on regulated categories before wider rollout.",
          last_status: "pending",
        },
      },
      {
        prose: "Loyalty points module merchants can switch on per store.",
        problem:
          "Repeat-purchase rate trails the category, and merchants ask for retention tooling they currently bolt on via third-party apps.",
        opportunity: "Make the after-purchase experience self-serve",
        stage: "parked",
        rejection_reason:
          "Parked 2026-05: real problem, but blocked behind the storefront re-architecture shipping in Q3 — building on the legacy theme engine would be thrown away. Revive when the new theme API is stable.",
      },
      {
        prose: "AR try-on so shoppers can place furniture in their room from the product page.",
        stage: "inbox",
      },
    ],
  },
  {
    key: "healthtech",
    owner: { name: "Clinical Product Lead" },
    ideas: [
      {
        prose:
          "SMS appointment reminders with a one-tap reschedule link instead of a phone number.",
        problem:
          "No-shows run 17% and front-desk staff spend mornings on reminder calls; patients say they'd have rescheduled if it didn't require a call during work hours.",
        opportunity: "Fill every clinic slot that would otherwise sit empty",
        stage: "promoted",
        promoted_to: "intent_01HREMINDERBET000000000001",
      },
      {
        prose: "Waitlist auto-fill: offer a canceled slot to matching waitlisted patients by SMS.",
        problem:
          "Same-day cancellations leave slots empty while the waitlist goes uncalled — staff don't have time to ring down the list.",
        opportunity: "Fill every clinic slot that would otherwise sit empty",
        stage: "triaged",
        related: 0,
      },
      {
        prose: "Ambient visit transcription drafting the encounter note for clinician sign-off.",
        problem:
          "Clinicians report 90+ minutes of after-hours charting per day; documentation burden is the top reason cited in exit interviews.",
        opportunity: "Give clinicians their evenings back",
        stage: "evaluating",
        assessment: {
          prose:
            "Four-clinic pilot, 40 clinicians, 6 weeks: median after-hours charting fell from 96 to 41 minutes; sign-off edits required on 22% of drafts. Verdict: validated on outcome; safety review next.",
          last_status: "pass",
        },
        evidence: [
          {
            label: "Pilot study writeup with per-clinic charting-time data",
            locator: "doc://research/ambient-scribe-pilot",
          },
        ],
      },
      {
        prose: "Patient-portal medication refill requests routed to the right nurse queue.",
        problem:
          "Refill requests arrive by phone, get transcribed onto sticky notes, and a third require a call back for missing pharmacy details.",
        opportunity: "Give clinicians their evenings back",
        stage: "triaged",
      },
    ],
  },
  {
    key: "internal-platform",
    owner: { name: "Platform Engineering Lead" },
    ideas: [
      {
        prose: "Self-serve dataset catalog with named owners and freshness SLAs on every table.",
        problem:
          "Analysts spend the first day of every project hunting for the right table and asking in Slack whether it's stale; trust in dashboards is eroding.",
        opportunity: "Make internal data findable and trustworthy",
        stage: "evaluating",
      },
      {
        prose: "Preview environment per pull request, torn down on merge.",
        problem:
          "QA queues on two shared staging environments; reviewers either rubber-stamp UI changes unseen or wait a day for a staging slot.",
        opportunity: "Cut the wait states out of the delivery loop",
        stage: "promoted",
        promoted_to: "intent_01HPREVIEWENVBET000000001",
      },
      {
        prose: "Cloud cost-anomaly alerts piped to the owning team's channel within an hour.",
        problem:
          "A misconfigured job burned $40k over a weekend before anyone noticed; finance finds anomalies at month-close, weeks after the fact.",
        opportunity: "Make internal data findable and trustworthy",
        stage: "triaged",
        evidence: [
          {
            label: "Finance escalation: weekend cost spike postmortem",
            locator: "doc://finops/spike-postmortem-2026-03",
          },
        ],
      },
      {
        prose: "Schema-change dry-run bot that comments breaking downstream queries on the PR.",
        problem:
          "Schema changes ship without knowing who consumes the column; three dashboards broke silently last quarter and were found by executives.",
        opportunity: "Make internal data findable and trustworthy",
        stage: "triaged",
        related: 0,
      },
      {
        prose:
          "Internal LLM gateway with per-team budgets, model allowlists, and prompt audit logs.",
        problem:
          "Teams are wiring their own LLM keys into tools with no spend control or audit trail; security flagged shadow AI usage in the last review.",
        opportunity: "Cut the wait states out of the delivery loop",
        stage: "evaluating",
      },
    ],
  },
  {
    key: "media-app",
    owner: { name: "Audience PM" },
    ideas: [
      {
        prose: "Weekly personalized digest email: three episodes picked from listening history.",
        problem:
          "Listeners who finish their subscriptions' new episodes run out of things to play and lapse — discovery is the top stated reason for churn in surveys.",
        opportunity: "Help every listener find their next favorite show",
        stage: "evaluating",
        assessment: {
          prose:
            "A/B over six weeks on 40k lapsed-risk listeners: digest arm returned at 31% vs 24% control. Verdict: pass — but open-rate decay after week three needs a content rotation fix before scale-out.",
          last_status: "pass",
        },
      },
      {
        prose: "Offline listening: download episodes for the commute.",
        problem:
          "Commuters on underground transit lose playback in dead zones; app reviews call it the one missing feature versus competitors.",
        opportunity: "Make listening survive a flaky connection",
        stage: "promoted",
        promoted_to: "intent_01HOFFLINEBET000000000001",
      },
      {
        prose: "Creator analytics dashboard: completion curves and audience geography per episode.",
        problem:
          "Creators publish blind — they see a download count but not where listeners drop off — and cite missing analytics when they move to other platforms.",
        opportunity: "Keep creators publishing here",
        stage: "triaged",
      },
      {
        prose: "Community Q&A thread attached to each episode.",
        stage: "inbox",
      },
      {
        prose: "Chapter markers in long episodes so listeners can jump to segments.",
        problem:
          "Listeners of 2h+ interview shows say they relisten to find one segment and often give up; power users keep timestamps in a notes app.",
        opportunity: "Help every listener find their next favorite show",
        stage: "triaged",
      },
    ],
  },
  {
    key: "hardware-iot",
    owner: { name: "Hardware PM, Devices" },
    ideas: [
      {
        prose: "QR-code pairing: scan the code on the device to join it to Wi-Fi from the app.",
        problem:
          "Bluetooth pairing fails on first attempt for 1 in 5 setups and drives the single largest support-call category; a third of returns are 'could not set up'.",
        opportunity: "Make day-one setup succeed without a support call",
        stage: "promoted",
        promoted_to: "intent_01HQRPAIRBET0000000000001",
      },
      {
        prose: "Replaceable battery module sold as a spare part with a tool-free latch.",
        problem:
          "Battery decay is the top reason for device replacement at year three; sustainability review flagged warranty e-waste, and owners ask to fix rather than replace.",
        opportunity: "Make the device last twice as long",
        stage: "parked",
        rejection_reason:
          "Parked 2026-04: requires an enclosure redesign that can only land with the v3 hardware revision (2027 tooling window). Revive when v3 industrial design starts; until then collect demand here.",
      },
      {
        prose:
          "Staged firmware rollouts for fleets: ship to 1% of an org's devices, then widen on health metrics.",
        problem:
          "Fleet operators delay updates for fear of bricking a thousand devices at once, so known bugs stay in the field for months.",
        opportunity: "Make day-one setup succeed without a support call",
        stage: "evaluating",
        demand: [
          {
            prose: "Logistics customer (3,200 devices) asked for canary rollouts in QBR.",
            happened_at: "2026-05-06T14:00:00Z",
          },
        ],
      },
      {
        prose:
          "Education tier: classroom device management with student privacy defaults and bulk enrollment.",
        problem:
          "Teachers buy consumer units and hand-configure each one; a trickle of inbound asks for classroom management, but the segment is unproven.",
        opportunity: "Make the device last twice as long",
        stage: "parked",
        rejection_reason:
          "Parked 2026-05: inbound demand is real but small (11 schools), and the privacy/compliance load (COPPA, FERPA) is heavy. Revive if education inbound passes ~50 requests or a district-level deal appears.",
      },
      {
        prose:
          "White-label OEM program: partners embed the device under their own brand with our fleet API.",
        problem:
          "Two integrators asked to resell the device inside their own offering; without an OEM program they wrap our consumer SKU and break on every firmware update.",
        opportunity: "Make the device last twice as long",
        stage: "triaged",
        evidence: [
          {
            label: "Partnership inquiry thread: integrator OEM requests",
            locator: "doc://partnerships/oem-inquiries-2026",
          },
        ],
      },
    ],
  },
];

// ─── Suite A: no false positives on fifty well-formed ideas ────────────────────

describe("ideas template — fifty real-life ideas across ten portfolios", () => {
  it("seeds enforceable policies from the template", () => {
    // Node-type allowlist, edge-type allowlist, requires_field(problem), owner
    // attribution, opportunity floor + ceiling, assessment spine →
    // deterministic; membership, idea quality, assessment quality →
    // probabilistic.
    expect(policies.length).toBeGreaterThanOrEqual(8);
    expect(policies.some((p) => p.kind === "deterministic")).toBe(true);
    expect(policies.some((p) => p.kind === "probabilistic")).toBe(true);
  });

  it("the corpus really is fifty ideas, covering every funnel stage", () => {
    const all = PORTFOLIOS.flatMap((p) => p.ideas);
    expect(all).toHaveLength(50);
    const stages = new Set(all.map((i) => i.stage));
    for (const stage of ["inbox", "parked", "triaged", "evaluating", "promoted", "rejected"]) {
      expect(stages, `corpus covers the ${stage} stage`).toContain(stage);
    }
  });

  for (const s of PORTFOLIOS) {
    it(`${s.key}: every node passes the deterministic gates with no block or warn`, () => {
      const g = buildPortfolio(s);
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

  it("queues exactly the right probabilistic checks per node type (saas-collab)", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    // A committed idea: the membership gate + the idea-quality judge.
    const committed = g.ideas[1];
    expect(committed.lifecycle).toBe("active");
    expect(probabilisticLabels(evaluate(committed, g))).toEqual(
      new Set(["membership", "idea-quality"]),
    );
    // A drafting inbox jot: membership only — quality judges spare the inbox.
    const inboxJot = buildPortfolio(PORTFOLIOS[1]).ideas[4];
    expect(inboxJot.lifecycle).toBe("drafting");
    expect(probabilisticLabels(evaluate(inboxJot, buildPortfolio(PORTFOLIOS[1])))).toEqual(
      new Set(["membership"]),
    );
    // An opportunity Intent: the membership gate only.
    expect(probabilisticLabels(evaluate(g.opportunities[0], g))).toEqual(new Set(["membership"]));
    // A committed assessment: the assessment-quality judge only.
    expect(probabilisticLabels(evaluate(g.assessments[0], g))).toEqual(
      new Set(["assessment-quality"]),
    );
    // Supporting cast — owner, demand Logs, evidence References — is unjudged.
    expect(probabilisticLabels(evaluate(g.owner, g))).toEqual(new Set());
  });

  it("a retired (promoted/rejected) idea is not re-judged for completeness", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    const promoted = g.ideas[0];
    expect(promoted.lifecycle).toBe("retired");
    expect(deterministicBlocks(evaluate(promoted, g))).toEqual([]);
  });
});

// ─── Suite B: catches real modeling mistakes (deterministic gates) ─────────────

describe("ideas template — blocks malformed ideas", () => {
  it("blocks a committed idea that names no `problem` (the separation floor)", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    const solutionOnly = node("idea", "saas-collab", { prose: "Build an AI assistant." }, "active");
    g.nodes.push(solutionOnly);
    g.edges.push(edge(solutionOnly.id, g.owner.id, "attributed_to"));
    g.edges.push(edge(solutionOnly.id, g.opportunities[0].id, "has_parent"));
    const blocks = deterministicBlocks(evaluate(solutionOnly, g));
    expect(blocks.map((b) => b.sub_kind)).toContain("requires_field");
    expect(blocks.some((b) => /problem/.test(b.reason))).toBe(true);
  });

  it("blocks a committed idea with no shepherding owner (the attribution floor)", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    const ownerless = node(
      "idea",
      "saas-collab",
      { prose: "Add usage analytics.", problem: "Admins can't see seat utilization." },
      "queued",
    );
    g.nodes.push(ownerless);
    g.edges.push(edge(ownerless.id, g.opportunities[0].id, "has_parent"));
    const blocks = deterministicBlocks(evaluate(ownerless, g));
    expect(
      blocks.some((b) => b.sub_kind === "requires_edge" && /attributed_to/.test(b.reason)),
    ).toBe(true);
  });

  it("warns (not blocks) on a committed idea with no opportunity link", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    const homeless = node(
      "idea",
      "saas-collab",
      { prose: "Add usage analytics.", problem: "Admins can't see seat utilization." },
      "active",
    );
    g.nodes.push(homeless);
    g.edges.push(edge(homeless.id, g.owner.id, "attributed_to"));
    const vs = evaluate(homeless, g);
    expect(deterministicBlocks(vs)).toEqual([]);
    expect(
      deterministicWarns(vs).some(
        (w) => w.sub_kind === "requires_edge" && /has_parent/.test(w.reason),
      ),
    ).toBe(true);
  });

  it("blocks a committed idea pinned to TWO opportunities (the single-target ceiling)", () => {
    const s = PORTFOLIOS[0];
    const g = buildPortfolio(s);
    const torn = node(
      "idea",
      "saas-collab",
      { prose: "Add usage analytics.", problem: "Admins can't see seat utilization." },
      "active",
    );
    g.nodes.push(torn);
    g.edges.push(edge(torn.id, g.owner.id, "attributed_to"));
    g.edges.push(edge(torn.id, g.opportunities[0].id, "has_parent"));
    g.edges.push(edge(torn.id, g.opportunities[1].id, "has_parent"));
    const blocks = deterministicBlocks(evaluate(torn, g));
    expect(blocks.some((b) => b.sub_kind === "limits_edge")).toBe(true);
  });

  it("blocks a committed assessment that assesses nothing (no `supports` edge)", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    const dangling = node(
      "eval",
      "saas-collab",
      { prose: "ICE score 21/30.", last_status: "pass" },
      "active",
    );
    g.nodes.push(dangling);
    const blocks = deterministicBlocks(evaluate(dangling, g));
    expect(blocks.some((b) => b.sub_kind === "requires_edge" && /supports/.test(b.reason))).toBe(
      true,
    );
  });

  it("blocks node types outside the allowlist (action, state, decision)", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    for (const t of ["action", "state", "decision"]) {
      const stray = node(t, "saas-collab", { prose: "stray content" }, "active");
      const blocks = deterministicBlocks(evaluate(stray, g));
      expect(
        blocks.some((b) => b.sub_kind === "requires_node_type"),
        `${t} should be rejected by the node-type allowlist`,
      ).toBe(true);
    }
  });

  it("admits an owner Principal and a criteria Rule (no block)", () => {
    const g = buildPortfolio(PORTFOLIOS[0]);
    const owner = node("principal", "saas-collab", { name: "Triage owner" }, "active");
    expect(deterministicBlocks(evaluate(owner, g))).toEqual([]);
    const rule = node(
      "rule",
      "saas-collab",
      {
        prose: "Score ideas with ICE; an idea graduates to evaluation at 18/30 or higher.",
        predicate: "ICE score >= 18",
      },
      "active",
    );
    expect(deterministicBlocks(evaluate(rule, g))).toEqual([]);
  });
});

// ─── Suite C: completeness floors are committed-only; the inbox is exempt ──────

describe("ideas template — problem & owner required only once committed", () => {
  function bareIdeaAt(lifecycle: Lifecycle): { candidate: CandidateFields; graph: Graph } {
    const g = buildPortfolio(PORTFOLIOS[1]);
    // A bare jot: no problem, no owner edge, no opportunity.
    const bare = node("idea", "fitness-app", { prose: "Gamified onboarding quest?" }, lifecycle);
    g.nodes.push(bare);
    return { candidate: bare, graph: g };
  }
  const missingProblem = (b: Violation) =>
    b.sub_kind === "requires_field" && /problem/.test(b.reason);
  const missingOwner = (b: Violation) =>
    b.sub_kind === "requires_edge" && /attributed_to/.test(b.reason);

  it("a drafting inbox jot may be a bare one-liner (no blocks, no warns)", () => {
    const { candidate, graph } = bareIdeaAt("drafting");
    const vs = evaluate(candidate, graph);
    expect(deterministicBlocks(vs)).toEqual([]);
    expect(deterministicWarns(vs)).toEqual([]);
  });

  it("a queued (triaged) idea must carry its problem and owner", () => {
    const { candidate, graph } = bareIdeaAt("queued");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingProblem)).toBe(true);
    expect(blocks.some(missingOwner)).toBe(true);
  });

  it("an active (in-evaluation) idea must carry its problem and owner", () => {
    const { candidate, graph } = bareIdeaAt("active");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingProblem)).toBe(true);
    expect(blocks.some(missingOwner)).toBe(true);
  });

  it("a retired (closed) idea is not re-judged for completeness", () => {
    const { candidate, graph } = bareIdeaAt("retired");
    const blocks = deterministicBlocks(evaluate(candidate, graph));
    expect(blocks.some(missingProblem)).toBe(false);
    expect(blocks.some(missingOwner)).toBe(false);
  });
});

// ─── Suite D: the edge-type allowlist (relationships) ─────────────────────────

describe("ideas template — edge-type allowlist", () => {
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
    "supports",
    "attributed_to",
    "constrained_by",
    "relates_to",
    "replaces",
    "derived_from",
  ]) {
    it(`admits \`${allowed}\``, () => {
      expect(barred(evalEdge(allowed))).toBe(false);
    });
  }

  it("bars `flows_to` — an idea funnel has no process sequence flow", () => {
    expect(barred(evalEdge("flows_to"))).toBe(true);
  });
});

// ─── Suite E: end-to-end through the real runner + a stubbed LLM judge ─────────

describe("ideas template — end-to-end via runAuthoringPolicies", () => {
  it("blocks an Action via the node-type allowlist (no judge needed)", async () => {
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "action_ideae2e-0",
        node_type: "action",
        doco_id: docoId,
        prose: "Build the loyalty module.",
        lifecycle: "active",
      },
    });
    expect(judge.run).not.toHaveBeenCalled();
    expect(result.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("blocks a committed idea missing its problem and owner", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "idea_ideae2e-1",
        node_type: "idea",
        doco_id: docoId,
        prose: "Add an AI assistant.",
        lifecycle: "active",
      },
    });
    expect(result.violations.some((v) => v.sub_kind === "requires_field")).toBe(true);
    expect(result.violations.some((v) => v.sub_kind === "requires_edge")).toBe(true);
    expect(result.blocking).not.toBeNull();
  });

  it("does not block a drafting inbox jot even with no problem or owner", async () => {
    judge.run.mockResolvedValue({ ok: true });
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: "idea_ideae2e-2",
        node_type: "idea",
        doco_id: docoId,
        prose: "What if onboarding were a game?",
        lifecycle: "drafting",
      },
    });
    expect(result.blocking).toBeNull();
  });

  it("passes a fully-wired committed idea (problem + owner + opportunity in the DB)", async () => {
    judge.run.mockResolvedValue({ ok: true });
    // Persist the supporting graph the way capture would: the idea row, its
    // shepherd, its opportunity, and the two edges that wire them up.
    const ideaId = "idea_01IDEAE2EFULL000000000001";
    const ownerId = "principal_01IDEAE2EOWNER0000000001";
    const oppId = "intent_01IDEAE2EOPP000000000001";
    await dbm.db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES
         ($1, $4, 'idea', 'drafting', 'Same-day payout tier.'),
         ($2, $4, 'principal', 'active', 'Payments PM'),
         ($3, $4, 'intent', 'active', 'Make payouts fast enough that merchants stop churning')`,
      [ideaId, ownerId, oppId, docoId],
    );
    await dbm.db.query(
      `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type) VALUES
         ('edge_01IDEAE2E0000000000000001', $4, 'attributed_to', $1, 'idea', $2, 'principal'),
         ('edge_01IDEAE2E0000000000000002', $4, 'has_parent', $1, 'idea', $3, 'intent')`,
      [ideaId, ownerId, oppId, docoId],
    );
    const result = await runAuthoringPolicies({
      docoId,
      candidate: {
        id: ideaId,
        node_type: "idea",
        doco_id: docoId,
        prose: "Same-day payout tier (paid) for merchants who need today's takings tonight.",
        problem:
          "Cash-tight merchants churn to providers with faster settlement; exit surveys rank payout speed above fees.",
        lifecycle: "queued",
      },
    });
    expect(
      result.violations.filter((v) => v.kind === "deterministic"),
      result.violations.map((v) => `${v.sub_kind}: ${v.reason}`).join("; "),
    ).toEqual([]);
    expect(result.blocking).toBeNull();
  });
});
