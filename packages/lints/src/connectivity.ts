import type { PoolClient } from "pg";
import { parse as parseYaml } from "yaml";
import type { LintIssue } from "./types.js";

/**
 * Connectivity lint (ADR-075).
 *
 * Every "content" entity should have at least one outbound edge to another
 * non-trivial entity. Otherwise the node is isolated — invisible to
 * graph-traversal queries, missed by ripple-effect updates, and likely to
 * rot quietly.
 *
 * Rules:
 *  - Decision: ≥1 edge to (intent | rule | decision) AND ≥1 scope (ADR-079)
 *  - Action:   ≥1 edge to (intent | decision) AND ≥1 scope (ADR-079)
 *  - Rule:     applies_to.scopes or applies_to.types must be non-empty
 *  - Idea:     ≥1 scope (its topical home)
 *  - Intent:   ≥1 scope (top-level intents need a topical home)
 */
export const lintConnectivity = async (
  c: PoolClient,
  docoId: string,
): Promise<LintIssue[]> => {
  const issues: LintIssue[] = [];

  await checkScopeFreeEntities(
    c,
    docoId,
    "decisions",
    "Decision",
    issues,
    async (id) => {
      const n = await countOutboundEdgesToTypes(c, docoId, id, ["intent", "rule", "decision"]);
      if (n === 0) {
        issues.push({
          lintId: "connectivity",
          severity: "warning",
          source: id,
          message:
            "Decision has no outbound edge to any Intent / Rule / Decision. Add intent_ids, rules_consulted, or supersedes/superseded_by — otherwise the Decision is isolated and won't surface in topical searches.",
        });
      }
    },
  );

  await checkScopeFreeEntities(
    c,
    docoId,
    "actions",
    "Action",
    issues,
    async (id) => {
      const n = await countOutboundEdgesToTypes(c, docoId, id, ["intent", "decision"]);
      if (n === 0) {
        issues.push({
          lintId: "connectivity",
          severity: "warning",
          source: id,
          message:
            "Action has no outbound edge to any Intent or Decision. Add intent_ids or decision_ids — otherwise the designed step floats free of its rationale.",
        });
      }
    },
  );

  await checkScopeFreeEntities(
    c,
    docoId,
    "logs",
    "Log",
    issues,
    async (id) => {
      const n = await countOutboundEdgesToTypes(c, docoId, id, ["intent", "decision", "action"]);
      if (n === 0) {
        issues.push({
          lintId: "connectivity",
          severity: "warning",
          source: id,
          message:
            "Log has no outbound edge to an Intent, Decision, or Action template. Add intent_ids, decision_ids, or template_id — otherwise the recorded happening floats free of its rationale.",
        });
      }
    },
  );

  // Rules: applies_to is a free-form ScopeSelector (SCHEMA.md §5).
  const rules = (
    await c.query<{ id: string; raw_yaml: string }>(
      `SELECT id, raw_yaml FROM rules WHERE doco_id = $1`,
      [docoId],
    )
  ).rows;
  for (const r of rules) {
    const e = safeParseYaml(r.raw_yaml);
    if (!isAppliesToConnected(e?.applies_to)) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: r.id,
        message:
          "Rule has empty applies_to — it can't be applied to anything. Add at least one selector field (scope, node_type, all_of, etc.).",
      });
    }
  }

  // Ideas + Intents — require at least one scope.
  await checkScopeFreeEntities(c, docoId, "ideas", "Idea", issues);
  await checkScopeFreeEntities(c, docoId, "intents", "Intent", issues);

  return issues;
};

/**
 * For every entity in `table`, parse its raw_yaml and:
 *  1. Optionally run `extra` (e.g., outbound-edge checks).
 *  2. Always: warn if it has no scopes.
 */
async function checkScopeFreeEntities(
  c: PoolClient,
  docoId: string,
  table: "decisions" | "actions" | "logs" | "ideas" | "intents",
  display: string,
  issues: LintIssue[],
  extra?: (id: string) => Promise<void>,
): Promise<void> {
  const rows = (
    await c.query<{ id: string; raw_yaml: string }>(
      `SELECT id, raw_yaml FROM ${table} WHERE doco_id = $1`,
      [docoId],
    )
  ).rows;
  for (const r of rows) {
    if (extra) await extra(r.id);
    const e = safeParseYaml(r.raw_yaml);
    if (!Array.isArray(e?.scopes) || e.scopes.length === 0) {
      issues.push({
        lintId: "connectivity",
        severity: "warning",
        source: r.id,
        message: scopeMessage(display),
      });
    }
  }
}

function scopeMessage(display: string): string {
  switch (display) {
    case "Decision":
      return "Decision has no scopes — assign at least one scope so it can be discovered by topic. Per ADR-079.";
    case "Action":
      return "Action has no scopes — assign at least one scope so it can be discovered by topic. Per ADR-079.";
    case "Log":
      return "Log has no scopes — assign at least one scope so the recorded event can be discovered by topic.";
    case "Idea":
      return "Idea has no scopes — assign at least one scope so it can be discovered by topic.";
    case "Intent":
      return "Intent has no scopes — assign at least one scope so downstream Decisions/Actions can find it by topic.";
    default:
      return `${display} has no scopes — assign at least one scope.`;
  }
}

async function countOutboundEdgesToTypes(
  c: PoolClient,
  docoId: string,
  fromId: string,
  types: readonly string[],
): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM edges
      WHERE from_id = $1 AND to_node_type = ANY($2::text[]) AND doco_id = $3`,
    [fromId, [...types], docoId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

function safeParseYaml(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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
  for (const [k, v] of Object.entries(sel)) {
    if (k === "all" || k === "any_of" || k === "all_of") continue;
    if (v !== undefined && v !== null && v !== "") return true;
  }
  return false;
}
