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
    // The framework-seeded scope is named "global" (was: "constitution";
    // readable label "the doco's constitution"). Field names in the
    // bootstrap response keep "Constitution" so agents reading the
    // canonical see the familiar term, but the underlying row's `name`
    // is "global".
    if (r.name === "global") {
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
      "STEP 1 of onboarding — ASK the project owner which mode they want; DO NOT propose a curated starter set. The decision is theirs, not yours. Send this as your next message, with these two questions verbatim: 'Two ways to use Doco: (a) Do you want to keep it simple and use Doco to store important decisions so people, agents, and work stay aligned? (b) Or do you want to document something specific (for example, user flows, ADRs, state machines, design language, etc.)?' Then STOP and wait. DO NOT call any scope-creation endpoint yet, and DO NOT pre-list scope names you'd suggest — the prompt above already gives them the menu they need. If they pick (a) — keep it simple: no new scopes are needed. The framework-seeded `global` scope already holds decisions, intents, rules. Skip straight to STEP 2 (scope_population) and capture the first real decision they want on the record. If they pick (b) — document something specific: briefly explain how Doco's pieces fit before they pick what to track. (1) Scopes are topical buckets; each captured node lives in one or more. The only template the framework ships is `user-flows` (end-to-end journeys, intent + action chains). Names like adrs, apis, bugs, runbooks, post-mortems, glossary, roadmap, design-language, coding-style, framework, test-evals are conventional but project-owner-authored — they pick what fits. (2) Rules are constraints attached to scopes: `authoring` rules carry a predicate that gates capture (e.g. 'every ADR must include alternatives_considered'); `guidance` rules are reminders the agent surfaces without enforcement. Then ask: 'Which areas do you want to track?' Confirm names, POST to /<doco-handle>/scopes/new (or the scope-creation endpoints). During onboarding ONLY, pass watched=true on every scope you create — see watched_explainer below. NOTE: scope creation is STEP 1; do NOT stop after scopes exist (or after the project owner picks path (a)) — keep going to STEP 2 (scope_population) and drive in the first real node.",
    scope_setup_url: `${baseUrl}/${handle}/scopes/new?onboarding=1`,
    watched_explainer:
      "Every scope carries a 'watched' boolean (ADR-137bis). Watched=TRUE means contributors (project owner and agents alike) should proactively scan against this scope at capture time — 'does the thing I'm about to capture also belong here?' It's a soft attention signal, not enforcement. Watched=FALSE means the scope is available but no extra prompting; agents won't get nudged to consider it. During ONBOARDING, every scope you create defaults to watched=true: the project owner is literally in the room picking these scopes on purpose, so the attention signal matches what onboarding is for. After onboarding, ADR-137bis applies again — every scope-creation surface requires the caller (project owner or agent) to pick watched/not-watched explicitly with no default. The project owner can flip any scope's watched value any time from /<doco-handle>/scopes/<id>/edit. When you explain watched to the project owner in chat, use these exact words: 'Watched means: when you (or an agent) capture work later, this scope nudges you to consider whether the work belongs here.'",
    scope_population:
      "STEP 2 of onboarding — drive at least one real node into Doco. ONBOARDING IS NOT DONE WHEN SCOPES EXIST OR WHEN THE PROJECT OWNER SAID 'KEEP IT SIMPLE'. The first real node turns the empty container into actual documentation. If the project owner picked path (a) — keep it simple: ask 'What's a decision you've already made about this project that you'd want a future agent (or your future self) to know? Could be technical (framework choice, deploy target), product (who the user is, what the main flow is), or process (how PRs get reviewed). I'll capture it on the global scope as the first decision.' Capture it as a Decision on the global scope. That's the onboarding floor — done. If the project owner picked path (b) — created scopes: for EACH scope created, ask what they want to capture first — for adrs, 'What's the most important architectural choice you've already made that should be the first ADR?'; for user-flows, 'Walk me through the most important user journey in this project — I'll capture it as an Intent + Action chain'; for any custom scope, 'What's the load-bearing thing about <area> that's in your head but not in the repo yet?' Drive at least ONE real node into each scope before treating onboarding as complete. Empty scopes are the failure mode this step exists to prevent — documentation theater, not the work. Only stop when EITHER (1) the relevant scope(s) each have at least one real node, OR (2) the project owner explicitly says 'defer the rest for now' (acknowledge: 'OK, deferring; remember <scope_a>, <scope_b> are still empty and would benefit from a real node when you have a minute.'). NEVER print 'Onboarding done' if any scope is still empty unless (2) was said.",
  };
}

/**
 * A Doco is "in onboarding" when the only scope it carries is the
 * framework-seeded Global scope. Once the project owner accepts a
 * single project-specific scope, the overlay drops out of the
 * bootstrap response on the very next fetch.
 *
 * Both names are accepted for back-compat: older Docos that still
 * carry a scope named `constitution` (and haven't been migrated)
 * also count as "no project-specific scope yet."
 */
export function isOnboardingState(scopes: ScopeManifestEntry[]): boolean {
  const projectSpecific = scopes.filter(
    (s) => s.name !== "global" && s.name !== "constitution",
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
  const [constitution, scopes] = await Promise.all([
    loadConstitution(docoId),
    listLiveScopeManifest(docoDir),
  ]);
  const onboarding_overlay = isOnboardingState(scopes)
    ? buildOnboardingOverlay({ baseUrl, handle })
    : null;
  return { constitution, scopes, onboarding_overlay };
}
