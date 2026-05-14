import type { PoolClient } from "pg";
import type { LintIssue } from "./types.js";

/**
 * Every Decision in scope `scope_bugfix` should spawn at least one Rule in
 * scope `scope_regression_guard` via `BornFrom` (D-021 / D-016, ADR-078
 * tag→scope rename).
 */
export const lintBugfixGuard = async (
  c: PoolClient,
  docoId: string,
): Promise<LintIssue[]> => {
  const issues: LintIssue[] = [];

  const scopes = await c.query<{ id: string; name: string }>(
    `SELECT id, name FROM scopes WHERE doco_id = $1 AND name IN ('scope_bugfix', 'scope_regression_guard')`,
    [docoId],
  );
  const byName = new Map(scopes.rows.map((r) => [r.name, r.id]));
  const bugfixScopeId = byName.get("scope_bugfix");
  const guardScopeId = byName.get("scope_regression_guard");
  if (!bugfixScopeId || !guardScopeId) return issues;

  const bugfixes = (
    await c.query<{ from_id: string }>(
      `SELECT from_id FROM edges
        WHERE edge_type = 'in_scope_of'
          AND to_id = $1
          AND from_node_type = 'decision'
          AND doco_id = $2`,
      [bugfixScopeId, docoId],
    )
  ).rows;

  for (const fix of bugfixes) {
    const decisionId = fix.from_id;
    const guards = await c.query(
      `SELECT r.id FROM rules r
         JOIN edges b ON b.from_id = r.id AND b.edge_type = 'born_from' AND b.to_id = $1
         JOIN edges t ON t.from_id = r.id AND t.edge_type = 'in_scope_of' AND t.to_id = $2
        WHERE r.doco_id = $3`,
      [decisionId, guardScopeId, docoId],
    );
    if ((guards.rowCount ?? 0) === 0) {
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
