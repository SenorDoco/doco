// GET /api/v1/agent-bootstrap[?id=<doco_id>] — slim agent bootstrap.
//
// Returns the slim daily-use `canonical_instructions` (~1,200 tokens),
// plus a per-Doco `code_map` and `constitution` (Doco-specific
// load-bearing rules) when `?id=` is provided so the agent jumps
// straight to the right files and knows which rules will block a
// capture before drafting.
//
// For the long-form reference, fetch `/api/v1/agent-reference`. For
// per-Doco context (scopes, lint, freshness), `/by-id/<doco_id>/status.json`.

import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import type { AuthoringRule } from "@doco/shared";
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
 * Shape of the Constitution scope as exposed to agents on the bootstrap.
 */
export interface ConstitutionSnapshot {
  id: string;
  name: string;
  icon: string | null;
  /**
   * Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA the scope no longer carries
   * a dedicated `purpose` or `guidelines` field. The agent reads the
   * authoring rules (predicates the engine enforces) and the guidance
   * rules (prose to keep in mind while working) separately.
   */
  authoring_rules: AuthoringRule[];
  guidance_rules: string[];
}

/**
 * Read the Constitution scope from Postgres (`scopes` table). Returns
 * null when no Constitution scope exists (fresh docos pre-seed).
 * Filesystem walk of `<doco>/scopes/*.yaml` is gone
 * (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
 */
async function loadConstitution(docoId: string): Promise<ConstitutionSnapshot | null> {
  const rows = await listEntitiesByDoco("scope", docoId);
  for (const r of rows) {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded scope
    // is named "global" (was: "constitution"; readable label "the doco's
    // constitution"). Field names in the bootstrap response keep
    // "Constitution" so agents reading the canonical see the familiar
    // term, but the underlying scope row's `name` is "global".
    if (r.name !== "global") continue;
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(r.raw_yaml) as Record<string, unknown>;
    } catch {}
    return {
      id: r.id,
      name: r.name,
      icon: typeof fm.icon === "string" ? fm.icon : null,
      authoring_rules: Array.isArray(fm.authoring_rules)
        ? (fm.authoring_rules as AuthoringRule[])
        : [],
      guidance_rules: Array.isArray(fm.guidance_rules)
        ? (fm.guidance_rules as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [],
    };
  }
  return null;
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
      "STEP 1 of onboarding — set up scopes. DECIDE-AND-CONFIRM, not decide-and-execute. (1) Read the project (files, README, the description). (2) Propose a curated starter set to the project owner in plain prose: 'adrs' (architectural choices) + 'user-flows' (end-to-end journeys) + 1–2 CUSTOM scopes named for this project's actual subject areas (e.g. payments, search, content-schema). Ask them to confirm before materializing: 'For this project I'd start with adrs, user-flows, and a custom scope_<area> for <reason>. Sound right?' Then STOP and wait. (3) If the project is unclear, ASK FIRST — don't guess. Don't propose all eight built-in templates 'just in case' — adrs + user-flows + custom is the right starter shape; apis/bugs/runbooks/post-mortems/glossary/roadmap are available but the project owner adds them when the need arises. (4) Only after the project owner confirms, POST to /<owner>/<doco>/scopes/new or call the scope-creation endpoints. (5) During onboarding ONLY, pass watched=true on every scope you create — see watched_explainer below for what this means and why it's the onboarding default. (6) A single template scope alone is a smell — every onboarding session should produce at least one custom scope. NOTE: scope creation is STEP 1; do NOT stop after scopes exist — keep going to STEP 2 (scope_population).",
    scope_setup_url: `${baseUrl}/${ownerSlug}/${docoSlug}/scopes/new?onboarding=1`,
    watched_explainer:
      "Every scope carries a 'watched' boolean (ADR-137bis). Watched=TRUE means contributors (project owner and agents alike) should proactively scan against this scope at capture time — 'does the thing I'm about to capture also belong here?' It's a soft attention signal, not enforcement. Watched=FALSE means the scope is available but no extra prompting; agents won't get nudged to consider it. During ONBOARDING, every scope you create defaults to watched=true: the project owner is literally in the room picking these scopes on purpose, so the attention signal matches what onboarding is for. After onboarding, ADR-137bis applies again — every scope-creation surface requires the caller (project owner or agent) to pick watched/not-watched explicitly with no default. The project owner can flip any scope's watched value any time from /<owner>/<doco>/scopes/<id>/edit. When you explain watched to the project owner in chat, use these exact words: 'Watched means: when you (or an agent) capture work later, this scope nudges you to consider whether the work belongs here.'",
    scope_population:
      "STEP 2 of onboarding — drive real content into each scope. ONBOARDING IS NOT DONE WHEN SCOPES EXIST. For EACH scope you just created, ask the project owner what they want to capture first: for adrs, 'What's the most important architectural choice you've already made that should be the first ADR?'; for user-flows, 'Walk me through the most important user journey in this project — I'll capture it as an Intent + Action chain'; for any custom scope, 'What's the load-bearing thing about <area> that's in your head but not in the repo yet?' Drive at least ONE real node into each scope before treating onboarding as complete. Empty scopes are the failure mode this step exists to prevent — a scope shell with no nodes is documentation theater, not the work. Only stop when EITHER (a) each scope has at least one real node, OR (b) the project owner explicitly says 'defer the rest for now' (acknowledge: 'OK, deferring; remember <scope_a>, <scope_b> are still empty and would benefit from a real node when you have a minute.'). NEVER print 'Onboarding done' if any scope is still empty unless (b) was said.",
  };
}

/**
 * A Doco is "in onboarding" when the only scope it carries is the
 * framework-seeded Constitution. Once the project owner accepts a
 * single project-specific scope, the overlay drops out of the
 * bootstrap response on the very next fetch.
 */
function isOnboardingState(scopes: ScopeManifestEntry[]): boolean {
  const nonConstitution = scopes.filter((s) => s.name !== "constitution");
  return nonConstitution.length === 0;
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
      "Slim bootstrap. For deep reference fetch /api/v1/agent-reference. For per-Doco lint/status, call /by-id/<doco_id>/status.json. Pass ?id=<doco_id> to receive `code_map` + `constitution` (Doco-specific load-bearing rules enforced at capture time) + `scopes` (manifest with mandatory vs optional flag). When `onboarding_overlay` is non-null the Doco has only the Constitution scope — run STEP 1 (scope_setup) and STEP 2 (scope_population) before treating onboarding as done; the overlay disappears the moment the project owner accepts a first project-specific scope. When `missing_doco_guidance` is non-null the caller's id/slug didn't resolve OR resolved to a Doco they can't access — read the structured `actions` to pick the right recovery (create vs ask-for-access). `warning` carries a single-line version of the same.",
  });
}
