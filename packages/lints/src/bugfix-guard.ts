import type { Database } from "better-sqlite3";
import type { LintIssue } from "./types.js";

/**
 * Every Decision tagged `tag_bugfix` should spawn at least one Rule tagged
 * `tag_regression_guard` via `BornFrom` (D-021 / D-016).
 */
export const lintBugfixGuard = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];

  // Look up the tag IDs for tag_bugfix and tag_regression_guard.
  const bugfixTagId = (db.prepare("SELECT id FROM tag WHERE name = 'tag_bugfix'").get() as
    | { id: string }
    | undefined)?.id;
  const guardTagId = (db.prepare("SELECT id FROM tag WHERE name = 'tag_regression_guard'").get() as
    | { id: string }
    | undefined)?.id;

  if (!bugfixTagId || !guardTagId) return issues; // tags not present in this Evalo

  // All Decisions tagged tag_bugfix.
  const bugfixes = db
    .prepare(
      "SELECT from_id FROM edges WHERE edge_type = 'tagged' AND to_id = ? AND from_node_type = 'decision'",
    )
    .all(bugfixTagId) as { from_id: string }[];

  for (const fix of bugfixes) {
    const decisionId = fix.from_id;

    // Find Rules born_from this decision.
    const guards = db
      .prepare(
        `SELECT r.id FROM rule r
         JOIN edges b ON b.from_id = r.id AND b.edge_type = 'born_from' AND b.to_id = ?
         JOIN edges t ON t.from_id = r.id AND t.edge_type = 'tagged' AND t.to_id = ?`,
      )
      .all(decisionId, guardTagId) as { id: string }[];

    if (guards.length === 0) {
      issues.push({
        lintId: "bugfix-guard",
        severity: "warning",
        source: decisionId,
        message:
          "Decision tagged tag_bugfix has no Rule born_from it that is tagged tag_regression_guard.",
      });
    }
  }
  return issues;
};
