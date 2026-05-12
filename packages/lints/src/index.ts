import type { Database } from "better-sqlite3";
import { lintBugfixGuard } from "./bugfix-guard.js";
import { lintConnectivity } from "./connectivity.js";
import { lintFollowsCycle } from "./follows-cycle.js";
import { lintOrphanReasoning } from "./orphan-reasoning.js";
import type { Lint, LintIssue } from "./types.js";

export * from "./types.js";
export { lintBugfixGuard, lintConnectivity, lintFollowsCycle, lintOrphanReasoning };

// Principal-dependent lints (agent-ancestry, pii-display-name) were removed
// by ADR-087 — local-solo has no Principal entity to introspect.
export const SYSTEM_LINTS: Record<string, Lint> = {
  "orphan-reasoning": lintOrphanReasoning,
  "connectivity": lintConnectivity,
  "follows-cycle": lintFollowsCycle,
  "bugfix-guard": lintBugfixGuard,
};

export interface LintReport {
  total: number;
  errors: number;
  warnings: number;
  issuesByLint: Record<string, LintIssue[]>;
  issues: LintIssue[];
}

export function runAllLints(db: Database): LintReport {
  const issuesByLint: Record<string, LintIssue[]> = {};
  const all: LintIssue[] = [];
  for (const [name, lint] of Object.entries(SYSTEM_LINTS)) {
    const issues = lint(db);
    issuesByLint[name] = issues;
    all.push(...issues);
  }
  const errors = all.filter((i) => i.severity === "error").length;
  const warnings = all.filter((i) => i.severity === "warning").length;
  return { total: all.length, errors, warnings, issuesByLint, issues: all };
}
