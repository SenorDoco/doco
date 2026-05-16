// GET /api/v1/agent-bootstrap[?id=<doco_id>] — slim agent bootstrap.
//
// Returns the slim daily-use `canonical_instructions` (~1,200 tokens),
// plus a per-Doco `code_map` and `constitution` (Doco-specific
// load-bearing rules) when `?id=` is provided so the agent jumps
// straight to the right files and knows which rules will block a
// capture before drafting.
//
// For the long-form reference, fetch `/api/v1/agent-reference`. For
// per-Doco context (scopes, freshness), `/by-id/<doco_id>/status.json`.

import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import type { AuthoringPredicate } from "@doco/shared";
import { getDocoById, listEntitiesByDoco } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { canAccessDoco } from "~/lib/doco-access.server";
import { resolveDocoSlugAlias } from "~/lib/doco-aliases.server";
import { etaggedJson } from "~/lib/etag.server";
import { loadHostConfig } from "~/lib/host";
import {
  buildMissingDocoGuidance,
  formatMissingDocoLine,
  hostFromRequest,
  type MissingDocoGuidance,
} from "~/lib/missing-doco-guidance.server";
import {
  listScopeManifest,
  readDocoMetadata,
  type ScopeManifestEntry,
} from "~/lib/scope-helpers.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

/**
 * Shape of the Global scope (formerly "Constitution") as exposed to
 * agents on the bootstrap. Per decision_01KRPRDR1AD7S1RP6E69BQDB2G
 * authoring + guidance rules are first-class Rule entities tagged
 * `in_scope_of` this scope; the bootstrap surfaces them inline so
 * agents don't have to make extra calls.
 */
export interface ConstitutionSnapshot {
  id: string;
  name: string;
  icon: string | null;
  authoring_rules: { id: string; summary: string; predicate: AuthoringPredicate }[];
  guidance_rules: { id: string; summary: string }[];
}

/**
 * Read the Global scope + its rule entities from Postgres. Returns null
 * when no Global scope exists (fresh docos pre-seed).
 */
async function loadConstitution(docoId: string): Promise<ConstitutionSnapshot | null> {
  const rows = await listEntitiesByDoco("scope", docoId);
  let globalScope: { id: string; name: string; raw_yaml: string } | null = null;
  for (const r of rows) {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded scope
    // is named "global" (was: "constitution"; readable label "the doco's
    // constitution"). Field names in the bootstrap response keep
    // "Constitution" so agents reading the canonical see the familiar
    // term, but the underlying scope row's `name` is "global".
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

  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): a Rule is "authoring"
  // for the Global scope iff the scope cites it via `gated_by`. We
  // pull every active/proposed rule tagged in_scope_of Global, then
  // bucket by citation: ids ∈ gated_by → authoring; kind=guidance →
  // guidance; everything else → tagged (omitted here — tagged rules
  // show on the scope's page, not on the bootstrap surface).
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
 * Onboarding overlay (decision_01KRKZM14WNA1685GN0F12WCKM update):
 * when a Doco only has the framework-seeded Constitution scope and
 * no project-specific scopes yet, the agent that just fetched the
 * bootstrap is in onboarding mode — they need to set scopes up + drive
 * real content into each one. This is the content the old
 * /onboarding/create/agent.json overlay carried; now it rides on the
 * regular bootstrap response and decays the moment the project owner
 * accepts a first non-Constitution scope.
 */
interface OnboardingOverlay {
  scope_setup: string;
  scope_setup_url: string;
  watched_explainer: string;
  scope_population: string;
}

function buildOnboardingOverlay(args: {
  baseUrl: string;
  ownerSlug: string;
  docoSlug: string;
}): OnboardingOverlay {
  const { baseUrl, ownerSlug, docoSlug } = args;
  return {
    scope_setup:
      "STEP 1 of onboarding — set up scopes. DECIDE-AND-CONFIRM, not decide-and-execute. (1) Read the project (files, README, the description the project owner gave). (2) Propose a curated starter set to the project owner in plain prose: 'user-flows' (the only template the framework ships) PLUS 1–3 CUSTOM scopes named for this project's actual subject areas. Phrase it: 'For this project I'd start with user-flows (end-to-end journeys, from the template), plus custom scopes <name-for-area-1> for <reason> and <name-for-area-2> for <reason>. Sound right, or should I adjust?' Then STOP and wait — DO NOT call any scope-creation endpoint yet. (3) If the project is unclear, ASK FIRST: 'What areas of this project do you want to track separately?' (4) Only after the project owner confirms, POST to /<owner>/<doco>/scopes/new or call the scope-creation endpoints. (5) During onboarding ONLY, pass watched=true on every scope you create — see watched_explainer below for what this means and why it's the onboarding default. (6) A single template scope alone is a smell — every onboarding session should produce at least one CUSTOM scope named for a project-specific area. Conventional names like adrs/apis/bugs/runbooks/post-mortems/glossary/roadmap/design-language/coding-style/framework/test-evals are no longer auto-installed; they're project-owner-authored when needed. NOTE: scope creation is STEP 1; do NOT stop after scopes exist — keep going to STEP 2 (scope_population).",
    scope_setup_url: `${baseUrl}/${ownerSlug}/${docoSlug}/scopes/new?onboarding=1`,
    watched_explainer:
      "Every scope carries a 'watched' boolean (ADR-137bis). Watched=TRUE means contributors (project owner and agents alike) should proactively scan against this scope at capture time — 'does the thing I'm about to capture also belong here?' It's a soft attention signal, not enforcement. Watched=FALSE means the scope is available but no extra prompting; agents won't get nudged to consider it. During ONBOARDING, every scope you create defaults to watched=true: the project owner is literally in the room picking these scopes on purpose, so the attention signal matches what onboarding is for. After onboarding, ADR-137bis applies again — every scope-creation surface requires the caller (project owner or agent) to pick watched/not-watched explicitly with no default. The project owner can flip any scope's watched value any time from /<owner>/<doco>/scopes/<id>/edit. When you explain watched to the project owner in chat, use these exact words: 'Watched means: when you (or an agent) capture work later, this scope nudges you to consider whether the work belongs here.'",
    scope_population:
      "STEP 2 of onboarding — drive real content into each scope. ONBOARDING IS NOT DONE WHEN SCOPES EXIST. For EACH scope you just created, ask the project owner what they want to capture first: for adrs, 'What's the most important architectural choice you've already made that should be the first ADR?'; for user-flows, 'Walk me through the most important user journey in this project — I'll capture it as an Intent + Action chain'; for any custom scope, 'What's the load-bearing thing about <area> that's in your head but not in the repo yet?' Drive at least ONE real node into each scope before treating onboarding as complete. Empty scopes are the failure mode this step exists to prevent — a scope shell with no nodes is documentation theater, not the work. Only stop when EITHER (a) each scope has at least one real node, OR (b) the project owner explicitly says 'defer the rest for now' (acknowledge: 'OK, deferring; remember <scope_a>, <scope_b> are still empty and would benefit from a real node when you have a minute.'). NEVER print 'Onboarding done' if any scope is still empty unless (b) was said.",
  };
}

/**
 * A Doco is "in onboarding" when the only scope it carries is the
 * framework-seeded Global scope (renamed from Constitution per
 * decision_01KRPNZY7W6CCMYNKGND67BP0B). Once the project owner
 * accepts a single project-specific scope, the overlay drops out
 * of the bootstrap response on the very next fetch.
 *
 * Both names are accepted for back-compat: older Docos that still
 * carry a scope named `constitution` (and haven't been migrated)
 * also count as "no project-specific scope yet."
 */
function isOnboardingState(scopes: ScopeManifestEntry[]): boolean {
  const projectSpecific = scopes.filter(
    (s) => s.name !== "global" && s.name !== "constitution",
  );
  return projectSpecific.length === 0;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") ?? "").trim();
  const id = (url.searchParams.get("id") ?? "").trim();
  const host = hostFromRequest(request);
  let codeMap: unknown | null = null;
  let constitution: ConstitutionSnapshot | null = null;
  let scopes: ScopeManifestEntry[] = [];
  let docoSlugPath: string | null = null;
  let docoIdPath: string | null = null;
  let warning: string | null = null;
  let missingDocoGuidance: MissingDocoGuidance | null = null;
  let onboardingOverlay: OnboardingOverlay | null = null;

  // When the caller's id/slug doesn't resolve (or resolves to a Doco
  // they can't access) we set `missingDocoGuidance` to the structured
  // recovery actions and mirror its single-line summary into `warning`
  // for older clients that only read the warning string. Three states
  // collapse into two recovery shapes: not_found (typo / never
  // created) and no_access (exists, wrong credentials).
  function flagMissing(state: "not_found" | "no_access", identifier: string) {
    missingDocoGuidance = buildMissingDocoGuidance({ state, identifier, host });
    warning = formatMissingDocoLine(missingDocoGuidance);
  }

  // Accept `?id=doco_<ulid>` for per-Doco context. A legacy `?slug=`
  // parameter still resolves old callers, but ID is the stable path.
  let effectiveOwner: string | null = null;
  let effectiveDoco: string | null = null;
  let effectiveDocoId: string | null = null;
  if (id) {
    const row = await getDocoById(id);
    if (!row) {
      flagMissing("not_found", id);
    } else {
      effectiveOwner = row.owner_slug;
      effectiveDoco = row.doco_slug;
      effectiveDocoId = row.id;
    }
  } else if (slug && slug.includes("/")) {
    const [reqOwner, reqDoco] = slug.split("/", 2);
    if (reqOwner && reqDoco) {
      effectiveOwner = reqOwner;
      effectiveDoco = reqDoco;
    }
  }

  if (effectiveOwner && effectiveDoco && !warning) {
    // Resolve slug aliases (D-019: renames leave the old slug as an
    // alias to the canonical current one). When the caller used
    // `?id=`, the slug is already canonical — the resolver returns
    // `redirected: false` and this is a no-op.
    const resolved = await resolveDocoSlugAlias(effectiveOwner, effectiveDoco);
    if (!resolved) {
      flagMissing("not_found", `${effectiveOwner}/${effectiveDoco}`);
    } else {
      const dir = docoPath(resolved.ownerSlug, resolved.docoSlug);
      const meta = await readDocoMetadata(dir);
      if (!meta) {
        flagMissing("not_found", `${effectiveOwner}/${effectiveDoco}`);
      } else {
        // Apply the same privacy gate the per-Doco data routes use,
        // so bootstrap can't quietly report scopes/code_map for a
        // Doco the caller will then 404 on at search.json /
        // api/*.json. The previous gap was a misleading-success
        // signal — bootstrap said yes while data routes said no.
        const me = await getCurrentPrincipalAsync(request);
        if (!await canAccessDoco(meta, me?.id ?? null)) {
          flagMissing("no_access", `${effectiveOwner}/${effectiveDoco}`);
        } else {
          // code_map.yaml is gone (alpha forbids back-compat); keep
          // the field in the response for client compatibility.
          codeMap = null;
          constitution = await loadConstitution(meta.docoId);
          scopes = await listScopeManifest(dir);
          docoSlugPath = `${resolved.ownerSlug}/${resolved.docoSlug}`;
          docoIdPath = effectiveDocoId ?? meta.docoId;
          if (resolved.redirected) {
            warning = `Slug "${effectiveOwner}/${effectiveDoco}" is an alias for "${docoSlugPath}". Pin DOCO_ID in AGENTS.md to avoid slug drift.`;
          }
          if (isOnboardingState(scopes)) {
            const reqUrl = new URL(request.url);
            const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
            onboardingOverlay = buildOnboardingOverlay({
              baseUrl,
              ownerSlug: resolved.ownerSlug,
              docoSlug: resolved.docoSlug,
            });
          }
        }
      }
    }
  }

  return etaggedJson(request, {
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    reference_url: "/api/v1/agent-reference",
    host: {
      name: (await loadHostConfig()).name,
      mode: "host",
    },
    doco_slug: docoSlugPath,
    doco_id: docoIdPath,
    code_map: codeMap,
    constitution,
    scopes,
    onboarding_overlay: onboardingOverlay,
    warning,
    missing_doco_guidance: missingDocoGuidance,
    note:
      "Slim bootstrap. For deep reference fetch /api/v1/agent-reference. For per-Doco status, call /by-id/<doco_id>/status.json. Pass ?id=<doco_id> to receive `code_map` + `constitution` (Doco-specific load-bearing rules enforced at capture time) + `scopes` (manifest with mandatory vs optional flag). When `onboarding_overlay` is non-null the Doco has only the Constitution scope — run STEP 1 (scope_setup) and STEP 2 (scope_population) before treating onboarding as done; the overlay disappears the moment the project owner accepts a first project-specific scope. When `missing_doco_guidance` is non-null the caller's id/slug didn't resolve OR resolved to a Doco they can't access — read the structured `actions` to pick the right recovery (create vs ask-for-access). `warning` carries a single-line version of the same.",
  });
}
