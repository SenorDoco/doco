import type { Database } from "better-sqlite3";
import type { LintIssue } from "./types.js";

/**
 * Every Decision in scope `scope_bugfix` should spawn at least one Rule in
 * scope `scope_regression_guard` via `BornFrom` (D-021 / D-016, ADR-078
 * tag→scope rename).
 */
export const lintBugfixGuard = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];

  // Look up the scope IDs for scope_bugfix and scope_regression_guard.
  const bugfixScopeId = (db.prepare("SELECT id FROM scope WHERE name = 'scope_bugfix'").get() as
    | { id: string }
    | undefined)?.id;
  const guardScopeId = (db
    .prepare("SELECT id FROM scope WHERE name = 'scope_regression_guard'")
    .get() as { id: string } | undefined)?.id;

  if (!bugfixScopeId || !guardScopeId) return issues; // scopes not present in this Doco

  // All Decisions in scope_bugfix.
  const bugfixes = db
    .prepare(
      "SELECT from_id FROM edges WHERE edge_type = 'in_scope_of' AND to_id = ? AND from_node_type = 'decision'",
    )
    .all(bugfixScopeId) as { from_id: string }[];

  for (const fix of bugfixes) {
    const decisionId = fix.from_id;

    // Find Rules born_from this decision that are in scope_regression_guard.
    const guards = db
      .prepare(
        `SELECT r.id FROM rule r
         JOIN edges b ON b.from_id = r.id AND b.edge_type = 'born_from' AND b.to_id = ?
         JOIN edges t ON t.from_id = r.id AND t.edge_type = 'in_scope_of' AND t.to_id = ?`,
      )
      .all(decisionId, guardScopeId) as { id: string }[];

    if (guards.length === 0) {
      issues.push({
        lintId: "bugfix-guard",
        severity: "warning",
        source: decisionId,
        message:
          "Decision in scope_bugfix has no Rule born_from it that is in scope_regression_guard.",
      });
    }
  }
  return issues;
};
