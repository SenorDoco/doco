import type { Database } from "better-sqlite3";
import type { LintIssue } from "./types.js";

/**
 * Resolves DECISIONS.md §13 #12 / ADR-054: Principal.display_name MUST NOT
 * match an email regex. Public Evalos expose principal display_names via the
 * agent-ancestry chain (PLANNING.md §3.4); leaking emails would be a privacy
 * regression.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const lintPiiDisplayName = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];
  const rows = db
    .prepare("SELECT id, display_name FROM principal")
    .all() as { id: string; display_name: string }[];

  for (const r of rows) {
    if (EMAIL_REGEX.test(r.display_name)) {
      issues.push({
        lintId: "pii-display-name",
        severity: "warning",
        source: r.id,
        message: `Principal.display_name "${r.display_name}" looks like an email address — potential PII leak in public Evalos.`,
      });
    }
  }
  return issues;
};
