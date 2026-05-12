import type { Database } from "better-sqlite3";
import type { LintIssue } from "./types.js";

/**
 * Connectivity lint (ADR-075).
 *
 * Every "content" entity should have at least one outbound edge to another
 * non-trivial entity. Otherwise the node is isolated — invisible to
 * graph-traversal queries, missed by ripple-effect updates, and likely to
 * rot quietly. Mirrors the orphan-reasoning lint's pattern across more types.
 *
 * Rules:
 *  - Decision: ≥1 edge to (intent | rule | decision) AND ≥1 scope (ADR-079)
 *  - Action:   ≥1 edge to (intent | decision) AND ≥1 scope (ADR-079)
 *  - Rule:     applies_to.scopes or applies_to.types must be non-empty
 *  - Idea:     ≥1 scope (its topical home)
 *  - Intent:   ≥1 scope (top-level intents need a topical home)
 *
 * Reasoning has its own dedicated lint (orphan-reasoning); not duplicated
 * here. Doco, Principal, Organization, Reference, Scope are exempt — they're
 * structural and standalone-ness is fine.
 *
 * Severity: warning (advisory). The first sweep will flag many existing
 * entities; tightening to error happens after backfill.
 */
export const lintConnectivity = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];

  // ── Decisions ──────────────────────────────────────────────────────────
  const decisions = db
    .prepare("SELECT id, raw_json FROM decision")
    .all() as { id: string; raw_json: string }[];
  for (const d of decisions) {
    const count = countOutboundEdgesToTypes(db, d.id, ["intent", "rule", "decision"]);
    if (count === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: d.id,
        message:
          "Decision has no outbound edge to any Intent / Rule / Decision. Add intent_ids, rules_consulted, or supersedes/superseded_by — otherwise the Decision is isolated and won't surface in topical searches.",
      });
    }
    // ADR-079: every Decision should also belong to ≥1 scope.
    const e = JSON.parse(d.raw_json) as Record<string, unknown>;
    if (!Array.isArray(e.scopes) || e.scopes.length === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: d.id,
        message:
          "Decision has no scopes — assign at least one scope so it can be discovered by topic. Per ADR-079.",
      });
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────
  const actions = db
    .prepare("SELECT id, raw_json FROM action")
    .all() as { id: string; raw_json: string }[];
  for (const a of actions) {
    const count = countOutboundEdgesToTypes(db, a.id, ["intent", "decision"]);
    if (count === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: a.id,
        message:
          "Action has no outbound edge to any Intent or Decision. Add intent_ids or decision_ids — otherwise the work-record floats free of its rationale.",
      });
    }
    // ADR-079: every Action should also belong to ≥1 scope.
    const e = JSON.parse(a.raw_json) as Record<string, unknown>;
    if (!Array.isArray(e.scopes) || e.scopes.length === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: a.id,
        message:
          "Action has no scopes — assign at least one scope so it can be discovered by topic. Per ADR-079.",
      });
    }
  }

  // ── Rules ──────────────────────────────────────────────────────────────
  // applies_to is a free-form ScopeSelector (SCHEMA.md §5; runtime/src/scope.ts).
  // Valid shapes include `{ all: true }`, `{ id: ... }`, `{ scope: ... }`,
  // `{ node_type: ..., verb: ... }`, `{ any_of: [...] }`, `{ all_of: [...] }`,
  // and the array forms `{ scopes: [...] }` / `{ types: [...] }`. A Rule is
  // disconnected only if its applies_to is missing, empty, or carries nothing
  // a ScopeSelector recognizes.
  const rules = db
    .prepare("SELECT id, raw_json FROM rule")
    .all() as { id: string; raw_json: string }[];
  for (const r of rules) {
    const e = JSON.parse(r.raw_json) as Record<string, unknown>;
    if (!isAppliesToConnected(e.applies_to)) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: r.id,
        message:
          "Rule has empty applies_to — it can't be applied to anything. Add at least one selector field (scope, node_type, all_of, etc.).",
      });
    }
  }

  // ── Ideas + Intents — require at least one scope ───────────────────────
  const ideas = db.prepare("SELECT id, raw_json FROM idea").all() as {
    id: string;
    raw_json: string;
  }[];
  for (const i of ideas) {
    const e = JSON.parse(i.raw_json) as Record<string, unknown>;
    if (!Array.isArray(e.scopes) || e.scopes.length === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: i.id,
        message:
          "Idea has no scopes — assign at least one scope so it can be discovered by topic.",
      });
    }
  }
  const intents = db.prepare("SELECT id, raw_json FROM intent").all() as {
    id: string;
    raw_json: string;
  }[];
  for (const i of intents) {
    const e = JSON.parse(i.raw_json) as Record<string, unknown>;
    if (!Array.isArray(e.scopes) || e.scopes.length === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: i.id,
        message:
          "Intent has no scopes — assign at least one scope so downstream Decisions/Actions can find it by topic.",
      });
    }
  }

  return issues;
};

/**
 * Count outbound edges from `fromId` whose target's node_type is in `types`.
 * Reads from the indexer's `edges` table.
 */
function countOutboundEdgesToTypes(
  db: Database,
  fromId: string,
  types: readonly string[],
): number {
  const placeholders = types.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM edges
       WHERE from_id = ? AND to_node_type IN (${placeholders})`,
    )
    .get(fromId, ...types) as { n: number };
  return row.n;
}

/**
 * Does this `applies_to` selector reach any candidate? True if it carries
 * any recognized ScopeSelector field. Mirrors the shapes accepted by
 * `runtime/src/scope.ts:matches`.
 */
function isAppliesToConnected(applies: unknown): boolean {
  if (applies === null || applies === undefined) return false;
  if (typeof applies !== "object") return false;
  const sel = applies as Record<string, unknown>;
  if (sel.all === true) return true;
  if (typeof sel.id === "string" && sel.id) return true;
  if (typeof sel.scope === "string" && sel.scope) return true;
  if (typeof sel.intent_id === "string" && sel.intent_id) return true;
  if (typeof sel.actor_type === "string" && sel.actor_type) return true;
  if (typeof sel.node_type === "string" && sel.node_type) return true;
  if (Array.isArray(sel.any_of) && sel.any_of.length > 0) return true;
  if (Array.isArray(sel.all_of) && sel.all_of.length > 0) return true;
  if (Array.isArray(sel.scopes) && sel.scopes.length > 0) return true;
  if (Array.isArray(sel.types) && sel.types.length > 0) return true;
  // Catch-all: any other field-value pair is a field-equality selector.
  for (const [k, v] of Object.entries(sel)) {
    if (k === "all" || k === "any_of" || k === "all_of") continue;
    if (v !== undefined && v !== null && v !== "") return true;
  }
  return false;
}
