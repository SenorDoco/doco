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
import { ensureScopeHashtagPrefixMigration } from "~/lib/migrations/scope-hashtag-prefix.server";
import { ensureScopePurposeMigration } from "~/lib/migrations/scope-purpose.server";
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
  /** Why the Global scope exists and what belongs inside it. */
  purpose: string;
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
  /**
   * Connector install hand-off — the FIRST onboarding action the agent
   * takes after a fresh create or redeem. Frame: "install once, future
   * sessions are cleaner." Even if the project owner declines, the
   * agent proceeds with the curl-based flow (no functional difference
   * for this session — MCP installs apply on the NEXT session).
   */
  connector_install: ConnectorInstall;
}

export interface ConnectorInstall {
  /** Prose the agent renders verbatim to ask the project owner. */
  prompt: string;
  /** Canonical MCP server URL the connector points at. */
  server_url: string;
  /** Per-runtime install commands, keyed by agent runtime. */
  install_commands: Record<string, string>;
  /** Prose the agent surfaces if the project owner declines. */
  on_decline: string;
  /** Where the human-facing equivalent lives in the web UI. */
  web_install_url: string;
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
    purpose: string | null;
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
        purpose: (r as { purpose?: string | null }).purpose ?? null,
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

  const columnPurpose = (globalScope.purpose ?? "").trim();
  const yamlPurpose =
    typeof scopeFm.purpose === "string" && scopeFm.purpose.trim() !== `Scope: ${globalScope.name}`
      ? scopeFm.purpose
      : "";
  const purpose = columnPurpose || yamlPurpose;
  const allowedNodeTypes = Array.isArray(scopeFm.allowed_node_types)
    ? (scopeFm.allowed_node_types as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return {
    id: globalScope.id,
    name: globalScope.name,
    purpose,
    allowed_node_types: allowedNodeTypes,
    icon: typeof scopeFm.icon === "string" ? scopeFm.icon : null,
    authoring_rules: authoring,
    guidance_rules: guidance,
  };
}

/**
 * Build the onboarding overlay text shown to an agent when their
 * Doco still has no captured user content. Two ordered imperatives:
 * STEP 1 = ask the project owner whether to run repo-onboarding now;
 * STEP 2 = read the repo and propose a batch of Decisions / Intents /
 * Rules for the project owner to confirm.
 *
 * v13 removed scopes (decision_01KS3DW9C2KN2X7Z80R18H1RAX), so this
 * overlay no longer walks a scope-by-scope checklist. The Doco's
 * template (chosen at create time) already pre-seeded any rules.
 */
export function buildOnboardingOverlay(args: {
  baseUrl: string;
  handle: string;
  /** Unused as of v13; accepted for back-compat with callers that
   *  still pass it. The checklist prose is gone. */
  scopes?: ScopeManifestEntry[];
}): OnboardingOverlay {
  const { baseUrl, handle } = args;
  return {
    scope_setup:
      "STEP 1 of onboarding — ask the project owner whether to run repo-onboarding right now. Send this verbatim as your next message: 'I can walk the repo and propose Decisions, Intents, and Rules for capture into this Doco. Want me to do that now, or skip for now?' Then STOP and wait. If they say go, proceed to STEP 2. If they decline, capture nothing yet and stop. NOTE: the Doco's template (chosen at /new-doco creation) already seeded any framework rules — you do NOT need to create scopes (scopes were removed in v13, decision_01KS3DW9C2KN2X7Z80R18H1RAX). Capture every project-specific Decision / Intent / Rule directly onto the Doco; routing is the Doco's job, not yours.",
    scope_setup_url: `${baseUrl}/new-doco`,
    watched_explainer:
      "v13 removed the per-scope `watched` flag along with scopes themselves (decision_01KS3DW9C2KN2X7Z80R18H1RAX). Captures land directly on the Doco; there is no per-section attention signal to set anymore. The Doco's `allowed_node_types` (from the template chosen at create time) is the only gate on what kind of nodes the Doco accepts.",
    connector_install: {
      prompt:
        "BEFORE we go any further with onboarding, do you want me to install the Doco MCP connector for you? It's a one-time install per agent runtime (Claude Code, Claude Desktop, Cursor, …). Future sessions in this project — and every other Doco-tracked project you have — get native Doco tools (search, list_scopes, capture_decision) without me having to curl them by hand. **It doesn't apply to this session** — MCP installs take effect on your next session/restart — so onboarding right now still runs through curl either way. Say 'yes install' or 'no skip' and I'll proceed.",
      server_url: `${baseUrl}/mcp`,
      install_commands: {
        claude_code: `claude mcp add doco ${baseUrl}/mcp`,
        claude_desktop: `Edit ~/Library/Application Support/Claude/claude_desktop_config.json — add { "mcpServers": { "doco": { "url": "${baseUrl}/mcp" } } }`,
        cursor: `Cursor → Settings → MCP → Add server. URL: ${baseUrl}/mcp`,
        codex: `Codex doesn't ship native MCP support yet — skip the install and proceed with curl.`,
        generic: `MCP server URL (Streamable HTTP transport): ${baseUrl}/mcp — paste into your agent runtime's MCP config.`,
      },
      on_decline:
        "OK, proceeding with curl-based onboarding. The connector is a quality-of-life upgrade — you can install anytime later from " +
        `${baseUrl}/${handle}/onboarding/agent` +
        " when you're ready. Continuing to STEP 1.",
      web_install_url: `${baseUrl}/${handle}/onboarding/agent`,
    },
    scope_population:
      "STEP 2 of onboarding — read the repo, identify load-bearing project knowledge, and propose a single batch of nodes for the project owner to confirm.\n\nREAD this set every time: README, CLAUDE.md / AGENTS.md, the framework's auto-memory or per-project agent memory, package.json / Cargo.toml / pyproject / go.mod, deploy config (vercel.json, fly.toml, Dockerfile, render.yaml), top-level directory structure, `git log --oneline -30`.\n\nBUCKET findings by node type. Common buckets:\n  - Decision — a one-time choice with alternatives considered. Example: 'Stack: vanilla JS + Vercel (rejected: Next.js / Astro).'\n  - Rule (authoring) — ongoing constraint with a predicate. Example: 'Every ADR must include alternatives_considered.'\n  - Rule (guidance) — ongoing reminder the agent surfaces without enforcement. Example: 'Verify on the deployed site, not locally.'\n  - Intent — a named goal or journey worth tracking. Example: 'New user signs up via GitHub.'\n\nPROPOSE the full batch in one message:\n\n        I read the repo and found these for capture:\n\n        Decisions (<N>):\n          1. <one-line> — alternatives: <X>\n          ...\n\n        Rules — authoring (<N>):\n          1. <one-line predicate>\n          ...\n\n        Rules — guidance (<N>):\n          1. <one-line reminder>\n          ...\n\n        Intents (<N>):\n          1. <one-line>\n          ...\n\n        Capture all of them, drop any you'd skip, or edit before capture — your call.\n\nWAIT for the project owner. Capture every approved finding in a single round. Respect the Doco's `allowed_node_types` if set by the template — if a captured type is rejected, the gate is doing its job; drop that bucket and move on.\n\nONLY STOP when EITHER (1) every approved finding has been captured, OR (2) the project owner says 'defer the rest for now'. NEVER print 'Onboarding done' until the project owner has explicitly confirmed.",
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
  // Then port any legacy primary-intent text onto Scope.purpose and
  // stamp template `allowed_node_types` onto rows that predate the
  // change (decision_01KRYECEA32SRSQCKFXSDCBK67).
  await ensureScopePurposeMigration(docoId);
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
