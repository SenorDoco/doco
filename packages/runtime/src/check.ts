import type { Database } from "better-sqlite3";
import type { Action, Entity, EntityId, Rule } from "@doco/shared";
import { evaluate, tryParsePredicate } from "./predicate.js";
import { matches } from "./scope.js";

export interface CheckResult {
  ruleId: EntityId<"rule">;
  ruleSlug?: string;
  modality: Rule["modality"];
  phase: Rule["phase"];
  result: "pass" | "fail" | "skipped";
  reason?: string;
}

export interface CheckReport {
  target: Action | Entity;
  results: CheckResult[];
  blocked: boolean;
}

/**
 * Run every applicable Rule against the given draft Action (or any entity).
 *
 * Picks Rules that:
 *   - have phase 'pre' or 'invariant'
 *   - match the candidate via Rule.applies_to (scope selector)
 *
 * Each Rule's predicate is evaluated against a context shaped as:
 *   {
 *     ...candidate fields directly...,
 *     actor: <Principal>          (if candidate is an Action)
 *     target: <Entity>            (if action.target is set)
 *   }
 */
export function checkAgainstRules(db: Database, candidate: Action | Entity): CheckReport {
  const results: CheckResult[] = [];
  const ctx = await_buildCtx(db, candidate);

  const ruleRows = db
    .prepare(
      "SELECT id, slug, modality, phase, on_violation, predicate, raw_json FROM rule WHERE phase IN ('pre', 'invariant') AND lifecycle = 'active'",
    )
    .all() as {
    id: string;
    slug: string | null;
    modality: Rule["modality"];
    phase: Rule["phase"];
    on_violation: Rule["on_violation"] | null;
    predicate: string | null;
    raw_json: string;
  }[];

  for (const row of ruleRows) {
    const rule = JSON.parse(row.raw_json) as Rule;
    const applies = matches(rule.applies_to as unknown, candidate as never, db);
    if (!applies) continue;

    if (!row.predicate) {
      results.push({
        ruleId: row.id as EntityId<"rule">,
        ...(row.slug ? { ruleSlug: row.slug } : {}),
        modality: row.modality,
        phase: row.phase,
        result: "skipped",
        reason: "Rule has no machine-checkable predicate (declared-only).",
      });
      continue;
    }

    const parsed = tryParsePredicate(row.predicate);
    if (!parsed) {
      results.push({
        ruleId: row.id as EntityId<"rule">,
        ...(row.slug ? { ruleSlug: row.slug } : {}),
        modality: row.modality,
        phase: row.phase,
        result: "skipped",
        reason: "Predicate is prose; runtime check skipped until JSON DSL or CEL is wired.",
      });
      continue;
    }

    const r = evaluate(parsed, ctx);
    const passed = row.modality === "must" ? r.ok : !r.ok; // must_not inverts
    results.push({
      ruleId: row.id as EntityId<"rule">,
      ...(row.slug ? { ruleSlug: row.slug } : {}),
      modality: row.modality,
      phase: row.phase,
      result: passed ? "pass" : "fail",
      ...(r.reason ? { reason: r.reason } : {}),
    });
  }

  const blocked = results.some(
    (r) => r.result === "fail" && (r.modality === "must" || r.modality === "must_not"),
  );

  return { target: candidate, results, blocked };
}

function await_buildCtx(db: Database, candidate: Action | Entity): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...(candidate as unknown as Record<string, unknown>) };
  if (candidate.node_type === "action") {
    const action = candidate as Action;
    // Principal table removed by ADR-087 — actor_id is now a free-form string.
    // The actor predicate (if any) receives just the string; runtime rules that
    // wanted to read actor.type === 'human' need a different shape post-collapse.
    if (action.actor_id) {
      ctx.actor = { id: action.actor_id, type: actorTypeFromString(action.actor_id) };
    }
    if (action.target) {
      const targetRow = (
        ["intent", "idea", "rule", "decision", "action", "reasoning", "evaluation", "reference", "scope"] as const
      )
        .map((t) =>
          db.prepare(`SELECT raw_json FROM ${t} WHERE id = ?`).get(action.target) as { raw_json: string } | undefined,
        )
        .find((r) => r !== undefined);
      if (targetRow) ctx.target = JSON.parse(targetRow.raw_json);
    }
  }
  return ctx;
}

/**
 * Convention-based actor "type" guess from a free-form actor_id string
 * (post ADR-087). Anything matching `<vendor>-<model>` or `claude-*`, `gpt-*`,
 * `gemini-*`, or containing a slash, is treated as an agent. Everything else
 * is "human". This is a best-effort shim so runtime rules that gated on
 * `actor.type === 'human'` (e.g., the bootstrap "only humans delete Docos"
 * rule) keep working without a Principal table.
 */
function actorTypeFromString(actor: string): "human" | "agent" {
  if (/^(claude|gpt|gemini|llama|mistral|grok|qwen|deepseek|opus|sonnet|haiku)-/i.test(actor))
    return "agent";
  if (actor.includes("/")) return "agent";
  return "human";
}
