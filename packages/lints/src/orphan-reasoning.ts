import type { Database } from "better-sqlite3";
import type { LintIssue } from "./types.js";

/**
 * Every Reasoning entity should have a conclusion_ref that resolves to a real
 * entity. Orphan Reasonings — no conclusion or pointing to nowhere — fail
 * this lint.
 */
export const lintOrphanReasoning = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];

  const rows = db
    .prepare("SELECT id, conclusion_ref FROM reasoning")
    .all() as { id: string; conclusion_ref: string | null }[];

  for (const r of rows) {
    if (!r.conclusion_ref) {
      issues.push({
        lintId: "orphan-reasoning",
        severity: "warning",
        source: r.id,
        message: "Reasoning has no conclusion_ref — orphan inference.",
      });
      continue;
    }
    // Resolve the conclusion_ref against any of the per-type tables.
    const found = anyTableHasId(db, r.conclusion_ref);
    if (!found) {
      issues.push({
        lintId: "orphan-reasoning",
        severity: "error",
        source: r.id,
        message: `conclusion_ref ${r.conclusion_ref} does not resolve to a known entity.`,
      });
    }
  }
  return issues;
};

function anyTableHasId(db: Database, id: string): boolean {
  for (const t of [
    "decision",
    "action",
    "intent",
    "idea",
    "rule",
    "reasoning",
    "evaluation",
    "principal",
    "reference",
    "scope",
  ]) {
    const row = db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id);
    if (row) return true;
  }
  return false;
}
