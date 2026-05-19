// Per-Doco context loaders for the agent-bootstrap response shape.
//
// The fields below (constitution, scopes manifest, onboarding overlay)
// historically lived in `app/routes/api.v1.agent-bootstrap.tsx`. They
// were lifted here so the create endpoint (POST /api/v1/docos.json)
// and the redeem endpoint (POST /api/v1/invites/<code>/redeem.json)
// can bundle them into their own responses — which removes the
// post-token-mint "second fetch returning instructions" pattern that
// trips agent-classifier credential-exfil heuristics.
//
// The agent-bootstrap route still uses these helpers for its on-demand
// per-Doco lookup; both call sites stay in lockstep.
import { listEntitiesByDoco } from "@doco/db";
import type { AuthoringPredicate } from "@doco/shared";
import { type ScopeManifestEntry, listLiveScopeManifest } from "~/lib/scope-helpers.server";
import { ensureScopeHashtagPrefixMigration } from "~/lib/migrations/scope-hashtag-prefix.server";
import { ensureScopeSummaryMigration } from "~/lib/migrations/scope-summary.server";

/**
 * Shape of the Global scope (formerly "Constitution") as exposed to
 * agents on the bootstrap. Authoring + guidance rules are first-class
 * Rule entities tagged `in_scope_of` this scope; the response
 * surfaces them inline so agents don't have to make extra calls.
 */
export interface ConstitutionSnapshot {
  id: string;
  name: string;
  /**
   * Description text rendered under the scope name on every surface and
   * carried here so agents see the constitution's purpose on session
   * load (decision_01KRYECEA32SRSQCKFXSDCBK67).
   */
  summary: string;
  /**
   * Generic scope attribute restricting which node types are accepted.
   * #global ships with `["rule"]` — the framework rejects POSTs of any
   * other node type whose scopes include #global
   * (rule_01KRYED1VAT3STXX6XP2GTP7V0).
   */
  allowed_node_types: string[];
  icon: string | null;
  authoring_rules: { id: string; summary: string; predicate: AuthoringPredicate }[];
  guidance_rules: { id: string; summary: string }[];
}

/**
 * Onboarding overlay: when a Doco only has the framework-seeded Global
 * scope and no project-specific scopes yet, the agent that just
 * onboarded is in onboarding mode — they need to set scopes up + drive
 * real content into each one. Decays the moment the project owner
 * accepts a first non-Global scope.
 */
export interface OnboardingOverlay {
  scope_setup: string;
  scope_setup_url: string;
  watched_explainer: string;
  scope_population: string;
}

/**
 * Read the Global scope + its rule entities from Postgres. Returns
 * null when no Global scope exists (fresh docos pre-seed; if the seed
 * hasn't completed for some reason, the response simply omits the
 * field rather than 500-ing).
 */
export async function loadConstitution(docoId: string): Promise<ConstitutionSnapshot | null> {
  const rows = await listEntitiesByDoco("scope", docoId);
  let globalScope: {
    id: string;
    name: string;
    raw_yaml: string;
    summary: string | null;
  } | null = null;
  for (const r of rows) {
    // The framework-seeded scope is named "#global" (history:
    // "constitution" → "global" → "#global", the last after the
    // hashtag-name shift). Field names in the bootstrap response keep
    // "Constitution" so agents reading the canonical see the familiar
    // term, but the underlying row's `name` is "#global". Older docos
    // that still carry a bare-name "global" row are accepted too — the
    // migration will rename them on the next capture pass.
    if (r.name === "#global" || r.name === "global") {
      globalScope = {
        id: r.id,
        name: r.name,
        raw_yaml: r.raw_yaml,
        summary: (r as { summary?: string | null }).summary ?? null,
      };
      break;
    }
  }
  if (!globalScope) return null;
  let scopeFm: Record<string, unknown> = {};
  try {
    scopeFm = JSON.parse(globalScope.raw_yaml) as Record<string, unknown>;
  } catch {}

  // A Rule is "authoring" for the Global scope iff the scope cites it
  // via `gated_by`. We pull every active/proposed rule tagged
  // in_scope_of Global, then bucket by citation: ids ∈ gated_by →
  // authoring; kind=guidance → guidance; everything else → tagged
  // (omitted here — tagged rules show on the scope's page, not on
  // the bootstrap surface).
  const { withClient } = await import("@doco/db");
  type RuleRow = { id: string; summary: string; raw_yaml: string };
  const ruleRows = await withClient(async (c) => {
    const r = await c.query<RuleRow>(
      `SELECT r.id, r.summary, r.raw_yaml
         FROM rules r
         JOIN edges e ON e.from_id = r.id
                     AND e.edge_type = 'in_scope_of'
                     AND e.to_id = $1
        WHERE r.doco_id = $2
          AND COALESCE(r.lifecycle, 'active') IN ('active', 'proposed')`,
      [globalScope.id, docoId],
    );
    return r.rows;
  });
  const gatedBy = new Set<string>(
    Array.isArray(scopeFm.gated_by)
      ? (scopeFm.gated_by as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  );
  const authoring: { id: string; summary: string; predicate: AuthoringPredicate }[] = [];
  const guidance: { id: string; summary: string }[] = [];
  for (const r of ruleRows) {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(r.raw_yaml) as Record<string, unknown>;
    } catch {}
    const kind = typeof fm.kind === "string" ? fm.kind : "tagged";
    const predicate = fm.predicate as AuthoringPredicate | undefined;
    if (gatedBy.has(r.id) && predicate && typeof predicate === "object") {
      authoring.push({ id: r.id, summary: r.summary, predicate });
    } else if (kind === "guidance") {
      guidance.push({ id: r.id, summary: r.summary });
    }
  }

  // Per decision_01KRYECEA32SRSQCKFXSDCBK67 the scope's description text
  // lives on the row's `summary` column. Prefer that, fall back to the
  // YAML mirror, and finally to an empty string for legacy rows that
  // applyScopeTemplateUpdatesToDoco hasn't migrated yet.
  const columnSummary = (globalScope.summary ?? "").trim();
  const yamlSummary =
    typeof scopeFm.summary === "string" && scopeFm.summary.trim() !== `Scope: ${globalScope.name}`
      ? scopeFm.summary
      : "";
  const summary = columnSummary || yamlSummary;
  const allowedNodeTypes = Array.isArray(scopeFm.allowed_node_types)
    ? (scopeFm.allowed_node_types as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return {
    id: globalScope.id,
    name: globalScope.name,
    summary,
    allowed_node_types: allowedNodeTypes,
    icon: typeof scopeFm.icon === "string" ? scopeFm.icon : null,
    authoring_rules: authoring,
    guidance_rules: guidance,
  };
}

/**
 * Build the onboarding overlay text shown to an agent when their
 * Doco only has the framework-seeded Global scope. Two ordered
 * imperatives: STEP 1 = scope setup (decide-and-confirm a starter
 * set); STEP 2 = scope population (drive at least one real node into
 * each scope before declaring onboarding done).
 */
export function buildOnboardingOverlay(args: {
  baseUrl: string;
  handle: string;
  /** Scope manifest at the time the overlay is built — used so the
   *  scope_population prose can name the actual checklist items the
   *  agent must walk and which ones still need bootstrapping. */
  scopes?: ScopeManifestEntry[];
}): OnboardingOverlay {
  const { baseUrl, handle, scopes = [] } = args;
  const checklistLines = scopes
    .map((s) => {
      const bootstrapped =
        typeof s.node_count === "number" && s.node_count > 0
          ? `[x] ${s.icon ? `${s.icon} ` : ""}${s.name} (${s.node_count} captured — already bootstrapped)`
          : `[ ] ${s.icon ? `${s.icon} ` : ""}${s.name}`;
      return `  - ${bootstrapped}`;
    })
    .join("\n");
  const checklistBlock = checklistLines
    ? `\n\nThis Doco's current scope checklist (render this verbatim before reading the repo, update the [ ] → [x] as you finish each scope):\n\nBootstrapping scopes:\n${checklistLines}\n`
    : "";
  return {
    scope_setup:
      "STEP 1 of onboarding — ASK the project owner which mode they want; DO NOT propose a curated starter set. The decision is theirs, not yours. Send this as your next message, with these two questions verbatim: 'Two ways to use Doco: (a) Do you want to keep it simple and use Doco to store important decisions so people, agents, and work stay aligned? (b) Or do you want to document something specific (for example, user flows, ADRs, state machines, design language, etc.)?' Then STOP and wait. DO NOT call any scope-creation endpoint yet, and DO NOT pre-list scope names you'd suggest — the prompt above already gives them the menu they need. If they pick (a) — keep it simple: no new scopes are needed. The framework-seeded `#global` scope already holds decisions, intents, rules. Skip straight to STEP 2 (scope_population) and capture the first real decision they want on the record. If they pick (b) — document something specific: briefly explain how Doco's pieces fit before they pick what to track. (1) Scopes are topical buckets; each captured node lives in one or more. Names are hashtag-shaped — they always start with `#` (e.g. `#user-flows`, `#payments`). The only template the framework ships is `#user-flows` (end-to-end journeys, intent + action chains). Names like `#adrs`, `#apis`, `#bugs`, `#runbooks`, `#post-mortems`, `#glossary`, `#roadmap`, `#design-language`, `#coding-style`, `#framework`, `#test-evals` are conventional but project-owner-authored — they pick what fits. (2) Rules are constraints attached to scopes: `authoring` rules carry a predicate that gates capture (e.g. 'every ADR must include alternatives_considered'); `guidance` rules are reminders the agent surfaces without enforcement. Then ask: 'Which areas do you want to track?' Confirm names, POST to /<doco-handle>/scopes/new (or the scope-creation endpoints). During onboarding ONLY, pass watched=true on every scope you create — see watched_explainer below. NOTE: scope creation is STEP 1; do NOT stop after scopes exist (or after the project owner picks path (a)) — keep going to STEP 2 (scope_population) and drive in the first real node.",
    scope_setup_url: `${baseUrl}/${handle}/scopes/new?onboarding=1`,
    watched_explainer:
      "Every scope carries a 'watched' boolean (ADR-137bis). Watched=TRUE means contributors (project owner and agents alike) should proactively scan against this scope at capture time — 'does the thing I'm about to capture also belong here?' It's a soft attention signal, not enforcement. Watched=FALSE means the scope is available but no extra prompting; agents won't get nudged to consider it. During ONBOARDING, every scope you create defaults to watched=true: the project owner is literally in the room picking these scopes on purpose, so the attention signal matches what onboarding is for. After onboarding, ADR-137bis applies again — every scope-creation surface requires the caller (project owner or agent) to pick watched/not-watched explicitly with no default. The project owner can flip any scope's watched value any time from /<doco-handle>/scopes/<id>/edit. When you explain watched to the project owner in chat, use these exact words: 'Watched means: when you (or an agent) capture work later, this scope nudges you to consider whether the work belongs here.'",
    scope_population:
      "STEP 2 of onboarding — bootstrap EVERY scope on the Doco, not just #global. The job is to lift every explicit statement the project owner has made about this project (across all scopes) into Doco as a Decision, Rule (authoring), or Rule (guidance). Comprehensive per scope, not sampled. Walk scope-by-scope with a visible checklist so the project owner can see progress.\n\nSTART WITH THE CHECKLIST. Render the block under `Bootstrapping scopes:` (see below) verbatim as one of your first lines after STEP 1 finishes. Rebuild it from the bootstrap response's `scopes` field; any scope already carrying captured nodes ships pre-checked (`[x]`) with the count — those scopes are already bootstrapped, skip them. Any scope with `[ ]` needs the read-propose-confirm loop below." +
      checklistBlock +
      "\nWALK SCOPE-BY-SCOPE. For each unchecked scope in the checklist, run this loop:\n\n  (1) READ what's relevant to THIS scope. Same source set every time (README, CLAUDE.md / AGENTS.md, the framework's auto-memory or per-project agent memory, package.json / Cargo.toml / pyproject / go.mod, deploy config — vercel.json, fly.toml, Dockerfile, render.yaml, etc., top-level directory structure, `git log --oneline -30`) but filter what you focus on by the scope's purpose. Cheat sheet:\n       - #global — RULES ONLY. The doco's rule book: standing rules, invariants, and authority claims anyone can cite from anywhere. The framework rejects non-Rule POSTs into this scope. Stack choice / deploy policy / workflow choices are Decisions — they go to #important (or a project-specific scope), NOT here.\n       - #important — Doco-wide Decisions that don't naturally fit a more specific subject-area scope. The catch-all bucket for stack choice, hosting, workflow conventions, and similar one-time choices with alternatives_considered.\n       - #user-flows — entry points, the main user journey, intent + action chains\n       - #adrs — architectural choices already made with alternatives considered\n       - #deployments — deploy target, push policy, environment config\n       - #design-language — visual conventions, layout patterns, component vocabulary\n       - any custom scope — read the scope's description first; treat its name as a topic filter\n\n  (2) BUCKET findings by node type AND route them to the right scope:\n       - Decision — one-time choice with alternatives considered. 'Stack: vanilla JS + Vercel (rejected: Next.js / Astro for build-step cost).' Decisions go to #important (or a project-specific scope like #deployments) — NEVER to #global.\n       - Rule (authoring) — ongoing constraint with a predicate that gates capture or commits. 'Don't commit unprompted.' 'Every ADR must include alternatives_considered.' Doco-wide rules go to #global.\n       - Rule (guidance) — ongoing reminder the agent surfaces without enforcement. 'Verify on the deployed site, not locally.' 'Document corrections same-turn.' Doco-wide guidance goes to #global.\n     If a finding doesn't fit any current scope, propose adding a new scope FIRST (per the #global rule 'Don't create a new scope to fit a node — propose it to the project owner and wait for their confirmation first'). Once the scope is approved, file the finding there.\n\n  (3) PROPOSE the batch for THIS scope only, grouped by what that scope accepts:\n\n        #global — I read the repo and the auto-memory and found these standing rules:\n\n        Authoring rules (<N>):\n          1. <one-line predicate>\n          ...\n\n        Guidance rules (<N>):\n          1. <one-line reminder>\n          ...\n\n        (Decisions I found while reading for #global — stack, hosting, workflow — propose under #important next.)\n\n     For other scopes, include the relevant types — Decisions in #important / project-specific scopes; the rule sections shown above only when the scope accepts Rule nodes. Always close with: 'Capture all of them, drop any you'd skip, or edit before capture — your call.'\n\n  (4) WAIT for the project owner. Capture in a single batch on their confirmation.\n\n  (5) UPDATE THE CHECKLIST. Re-render the full block with this scope flipped to [x] and the count, so the project owner sees the bootstrap progressing without scrolling back:\n\n        Bootstrapping scopes:\n        - [x] 🌐 #global (4 captured)\n        - [ ] 🌊 #user-flows  ← next\n        - [ ] 🚀 #deployments\n\n     The current-scope indicator (← next) is optional but useful for clarity.\n\n  (6) MOVE to the next unchecked scope. Repeat.\n\nA FEW NOTES:\n  - #global is rules-only. If you find yourself drafting a Decision and want to tag it #global, stop — that POST will be rejected. Route it to #important or a project-specific scope instead.\n  - If a finding could fit multiple scopes, use the MOST SPECIFIC (per the #global guidance rule 'Add each node to the most specific applicable scope'). A 'push to main on commit' decision lands on #deployments, not #important.\n  - You'll re-discover the same finding across scopes (a workflow rule shows up reading for #global and again for #user-flows). Capture it ONCE, on the most specific scope; mention to the project owner that you saw it elsewhere so they understand the routing.\n  - Capture authoring rules without overthinking the predicate during onboarding — propose the prose, the project owner can refine the predicate later.\n\nONLY STOP when EITHER (1) every scope on the checklist is checked off — every finding captured or explicitly skipped — OR (2) the project owner says 'defer the rest for now' (acknowledge by name: 'OK, deferring; #deployments and #design-language are still empty and would benefit from a real node when you have a minute.'). NEVER print 'Onboarding done' if any scope on the checklist is unchecked AND deferral wasn't explicit.",
  };
}

/**
 * A Doco is "in onboarding" — i.e. the agent should see scope_setup +
 * scope_population guidance — when EITHER:
 *
 *   (a) The only scope is the framework-seeded Global scope. The
 *       project owner hasn't picked a model yet, so scope_setup needs
 *       to ask the two-path question.
 *   (b) Any live scope has zero user-captured nodes. The path question
 *       may already be answered (path b created scopes), but those
 *       scopes are empty — scope_population needs to walk them.
 *
 * Once every live scope carries at least one user-captured node AND
 * (some project-specific scope exists OR the project owner picked
 * path-a and dropped a real decision on #global), the overlay drops
 * out of the bootstrap response.
 *
 * Three names are accepted for back-compat: the current canonical
 * `#global`, the post-rename bare `global`, and older docos that still
 * carry a scope named `constitution` (and haven't been migrated).
 */
export function isOnboardingState(scopes: ScopeManifestEntry[]): boolean {
  const projectSpecific = scopes.filter(
    (s) => s.name !== "#global" && s.name !== "global" && s.name !== "constitution",
  );
  if (projectSpecific.length === 0) return true;
  // Any live scope still empty? (node_count must be loaded for this
  // check; if it's undefined we conservatively assume not-empty so we
  // don't accidentally re-trigger the overlay on Docos whose
  // bootstrap path skipped the count.)
  return scopes.some((s) => typeof s.node_count === "number" && s.node_count === 0);
}

/**
 * Query node counts per scope in one round-trip. Returns a Map keyed
 * by scope id. Counts are over the union of decisions, rules,
 * intents, actions, logs, references, evals, and ideas — user-captured
 * content, not the framework-seeded scopes themselves.
 */
async function loadNodeCountsByScope(docoId: string): Promise<Map<string, number>> {
  const { withClient } = await import("@doco/db");
  type Row = { scope_id: string; node_count: string };
  const rows = await withClient(async (c) => {
    const r = await c.query<Row>(
      `SELECT e.to_id AS scope_id, COUNT(DISTINCT e.from_id) AS node_count
         FROM edges e
        WHERE e.edge_type = 'in_scope_of'
          AND e.doco_id = $1
        GROUP BY e.to_id`,
      [docoId],
    );
    return r.rows;
  });
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.scope_id, Number(row.node_count));
  }
  return out;
}

/**
 * Bundle the four per-Doco fields the wizard's first response needs.
 * Used by both the create + redeem endpoints (so Phase 4 disappears)
 * and by /api/v1/agent-bootstrap for refresh calls in later sessions.
 */
export interface BootstrapContext {
  constitution: ConstitutionSnapshot | null;
  scopes: ScopeManifestEntry[];
  onboarding_overlay: OnboardingOverlay | null;
}

/**
 * Load all per-Doco bootstrap-context fields in one shot. Returns
 * null when the Doco directory can't be read — caller decides what
 * to do (the create flow can't hit this; the redeem/bootstrap flow
 * surfaces a missing-doco warning).
 */
export async function loadBootstrapContext(args: {
  docoDir: string;
  docoId: string;
  handle: string;
  baseUrl: string;
}): Promise<BootstrapContext> {
  const { docoDir, docoId, handle, baseUrl } = args;
  // Run the scope-hashtag-prefix backfill before any read so the
  // bootstrap response (and every downstream consumer) sees the
  // canonical `#`-prefixed names. Idempotent + cached per-Doco.
  await ensureScopeHashtagPrefixMigration(docoId);
  // Then port any legacy primary-intent text onto Scope.summary and
  // stamp template `allowed_node_types` onto rows that predate the
  // change (decision_01KRYECEA32SRSQCKFXSDCBK67).
  await ensureScopeSummaryMigration(docoId);
  const [constitution, rawScopes, nodeCounts] = await Promise.all([
    loadConstitution(docoId),
    listLiveScopeManifest(docoDir),
    loadNodeCountsByScope(docoId),
  ]);
  // Enrich each manifest entry with its node_count. Scopes with no
  // edges in the in_scope_of join get an explicit 0 (not undefined) so
  // isOnboardingState can distinguish "empty" from "not loaded".
  const scopes = rawScopes.map((s) => ({
    ...s,
    node_count: nodeCounts.get(s.id) ?? 0,
  }));
  const onboarding_overlay = isOnboardingState(scopes)
    ? buildOnboardingOverlay({ baseUrl, handle, scopes })
    : null;
  return { constitution, scopes, onboarding_overlay };
}
