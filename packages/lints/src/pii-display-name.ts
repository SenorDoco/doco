import type { PoolClient } from "pg";
import type { LintIssue } from "./types.js";

/**
 * Resolves DECISIONS.md §13 #12 / ADR-054: Principal.display_name MUST NOT
 * match an email regex. Public docos expose principal display_names via the
 * agent-ancestry chain (PLANNING.md §3.4); leaking emails would be a privacy
 * regression. Principals are host-level — the check is global.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const lintPiiDisplayName = async (
  c: PoolClient,
  _docoId: string,
): Promise<LintIssue[]> => {
  const issues: LintIssue[] = [];
  const rows = (
    await c.query<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM principals WHERE display_name IS NOT NULL`,
    )
  ).rows;

  for (const r of rows) {
    if (r.display_name && EMAIL_REGEX.test(r.display_name)) {
      issues.push({
        lintId: "pii-display-name",
        severity: "warning",
        source: r.id,
        message: `Principal.display_name "${r.display_name}" looks like an email address — potential PII leak in public docos.`,
      });
    }
  }
  return issues;
};
