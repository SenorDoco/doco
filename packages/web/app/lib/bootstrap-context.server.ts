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

/**
 * Shape of the Global scope (formerly "Constitution") as exposed to
 * agents on the bootstrap. Authoring + guidance rules are first-class
 * Rule entities tagged `in_scope_of` this scope; the response
 * surfaces them inline so agents don't have to make extra calls.
 */
export interface ConstitutionSnapshot {
  id: string;
  name: string;
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
  let globalScope: { id: string; name: string; raw_yaml: string } | null = null;
  for (const r of rows) {
    // The framework-seeded scope is named "#global" (history:
    // "constitution" → "global" → "#global", the last after the
    // hashtag-name shift). Field names in the bootstrap response keep
    // "Constitution" so agents reading the canonical see the familiar
    // term, but the underlying row's `name` is "#global". Older docos
    // that still carry a bare-name "global" row are accepted too — the
    // migration will rename them on the next capture pass.
    if (r.name === "#global" || r.name === "global") {
      globalScope = { id: r.id, name: r.name, raw_yaml: r.raw_yaml };
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

  return {
    id: globalScope.id,
    name: globalScope.name,
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
}): OnboardingOverlay {
  const { baseUrl, handle } = args;
  return {
    scope_setup:
      "STEP 1 of onboarding — ASK the project owner which mode they want; DO NOT propose a curated starter set. The decision is theirs, not yours. Send this as your next message, with these two questions verbatim: 'Two ways to use Doco: (a) Do you want to keep it simple and use Doco to store important decisions so people, agents, and work stay aligned? (b) Or do you want to document something specific (for example, user flows, ADRs, state machines, design language, etc.)?' Then STOP and wait. DO NOT call any scope-creation endpoint yet, and DO NOT pre-list scope names you'd suggest — the prompt above already gives them the menu they need. If they pick (a) — keep it simple: no new scopes are needed. The framework-seeded `#global` scope already holds decisions, intents, rules. Skip straight to STEP 2 (scope_population) and capture the first real decision they want on the record. If they pick (b) — document something specific: briefly explain how Doco's pieces fit before they pick what to track. (1) Scopes are topical buckets; each captured node lives in one or more. Names are hashtag-shaped — they always start with `#` (e.g. `#user-flows`, `#payments`). The only template the framework ships is `#user-flows` (end-to-end journeys, intent + action chains). Names like `#adrs`, `#apis`, `#bugs`, `#runbooks`, `#post-mortems`, `#glossary`, `#roadmap`, `#design-language`, `#coding-style`, `#framework`, `#test-evals` are conventional but project-owner-authored — they pick what fits. (2) Rules are constraints attached to scopes: `authoring` rules carry a predicate that gates capture (e.g. 'every ADR must include alternatives_considered'); `guidance` rules are reminders the agent surfaces without enforcement. Then ask: 'Which areas do you want to track?' Confirm names, POST to /<doco-handle>/scopes/new (or the scope-creation endpoints). During onboarding ONLY, pass watched=true on every scope you create — see watched_explainer below. NOTE: scope creation is STEP 1; do NOT stop after scopes exist (or after the project owner picks path (a)) — keep going to STEP 2 (scope_population) and drive in the first real node.",
    scope_setup_url: `${baseUrl}/${handle}/scopes/new?onboarding=1`,
    watched_explainer:
      "Every scope carries a 'watched' boolean (ADR-137bis). Watched=TRUE means contributors (project owner and agents alike) should proactively scan against this scope at capture time — 'does the thing I'm about to capture also belong here?' It's a soft attention signal, not enforcement. Watched=FALSE means the scope is available but no extra prompting; agents won't get nudged to consider it. During ONBOARDING, every scope you create defaults to watched=true: the project owner is literally in the room picking these scopes on purpose, so the attention signal matches what onboarding is for. After onboarding, ADR-137bis applies again — every scope-creation surface requires the caller (project owner or agent) to pick watched/not-watched explicitly with no default. The project owner can flip any scope's watched value any time from /<doco-handle>/scopes/<id>/edit. When you explain watched to the project owner in chat, use these exact words: 'Watched means: when you (or an agent) capture work later, this scope nudges you to consider whether the work belongs here.'",
    scope_population:
      "STEP 2 of onboarding — lift everything the project owner has already said into Doco. ONBOARDING IS NOT DONE WHEN SCOPES EXIST OR WHEN THE PROJECT OWNER SAID 'KEEP IT SIMPLE'. It's done when every explicit statement the project owner has made about this project lives in Doco as a Decision, Rule (authoring), or Rule (guidance) — not a sample, not the top 2-3, all of them.\n\nBEFORE you ask the project owner what to capture, READ the repo and the framework's auto-memory and EXTRACT every explicit decision, rule, and guidance they've stated at any moment. Don't ask blindly. Don't sample. Sources to read carefully (not just skim):\n\n- README — intents and decisions stated outright (what the project is, who it's for, what 'done' looks like).\n- CLAUDE.md / AGENTS.md — workflow rules, what counts as done, narration discipline. The project owner's most explicit corrections usually live here.\n- The framework's auto-memory or per-project agent memory — every correction the project owner ever gave an agent. Usually Rule-shaped.\n- package.json / Cargo.toml / pyproject / go.mod / deploy config (vercel.json, fly.toml, Dockerfile, render.yaml, etc.) — stack choices: framework, db, deploy target.\n- Top-level directory structure and `git log --oneline -30` — intent reversals, pivots, conventions agreed on through history.\n\nBucket every finding by node type before proposing:\n\n- Decision — a one-time choice with alternatives considered. Examples: 'Stack: vanilla JS + Vercel (rejected: Next.js / Astro for build-step cost)'; 'Deploy target: push-to-main auto-deploy (rejected: PR-based staging for solo-dev simplicity)'.\n- Rule (authoring) — an ongoing constraint with a predicate that gates capture or commits. Examples: 'Every ADR must include alternatives_considered'; 'Don't commit unprompted — wait for an explicit commit instruction from the project owner'.\n- Rule (guidance) — an ongoing reminder the agent surfaces without enforcement. Examples: 'Verify on the deployed site, not locally — there is no local dev'; 'AI agents document every correction same-turn into Doco'.\n\nCapture EVERY explicit one — the job of bootstrap is to lift everything the project owner has already said out of the repo and into Doco so future agents (and the project owner's future self) don't have to re-derive it from CLAUDE.md, README, and git log every time. Sampling is the wrong default; comprehensive is the right one.\n\nFrame the proposal as a single batch grouped by type:\n\n    'I read the repo and the auto-memory and found these explicit decisions and rules — confirm which to capture:\n\n    Decisions (<N>):\n      1. <one-line> — alternatives: <X>\n      2. <one-line> — alternatives: <Y>\n      ...\n\n    Authoring rules (<N>):\n      1. <one-line predicate>\n      ...\n\n    Guidance rules (<N>):\n      1. <one-line reminder>\n      ...\n\n    Capture all of them, drop any you'd skip, or edit before capture — your call.'\n\nThen WAIT for the project owner to answer. Capture in a single batch after they confirm.\n\nScope assignment: if they picked path (a) — keep it simple — every captured node lands on #global. If they picked path (b) — created scopes — assign each capture to the right scope: project-wide stuff (workflow, stack, deploy policy) on #global; topical stuff on its matching scope (UI conventions on #design-language, deploy process on #deployments, architectural choices on #adrs, etc.).\n\nOnly stop when EITHER (1) every explicit statement you found has been captured or explicitly skipped by the project owner, OR (2) the project owner says 'defer the rest for now' (acknowledge: 'OK, deferring; <X>, <Y> are still in the repo but uncaptured and would benefit from a Doco entry when you have a minute.'). NEVER print 'Onboarding done' if explicit statements remain uncaptured AND (2) wasn't said.",
  };
}

/**
 * A Doco is "in onboarding" when the only scope it carries is the
 * framework-seeded Global scope. Once the project owner accepts a
 * single project-specific scope, the overlay drops out of the
 * bootstrap response on the very next fetch.
 *
 * Three names are accepted for back-compat: the current canonical
 * `#global`, the post-rename bare `global`, and older docos that still
 * carry a scope named `constitution` (and haven't been migrated). All
 * three count as "no project-specific scope yet."
 */
export function isOnboardingState(scopes: ScopeManifestEntry[]): boolean {
  const projectSpecific = scopes.filter(
    (s) => s.name !== "#global" && s.name !== "global" && s.name !== "constitution",
  );
  return projectSpecific.length === 0;
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
  const [constitution, scopes] = await Promise.all([
    loadConstitution(docoId),
    listLiveScopeManifest(docoDir),
  ]);
  const onboarding_overlay = isOnboardingState(scopes)
    ? buildOnboardingOverlay({ baseUrl, handle })
    : null;
  return { constitution, scopes, onboarding_overlay };
}
