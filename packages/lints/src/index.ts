import type { Database } from "better-sqlite3";
import { lintBugfixGuard } from "./bugfix-guard.js";
import { lintConnectivity } from "./connectivity.js";
import { lintDriftUncoveredChanges } from "./drift-uncovered-changes.js";
import { lintFollowsCycle } from "./follows-cycle.js";
import { lintOrphanReasoning } from "./orphan-reasoning.js";
import type { Lint, LintContext, LintIssue } from "./types.js";

export * from "./types.js";
export {
  lintBugfixGuard,
  lintConnectivity,
  lintDriftUncoveredChanges,
  lintFollowsCycle,
  lintOrphanReasoning,
};
export { computeCoverage } from "./coverage.js";
export type { CoverageOptions, CoverageReport } from "./coverage.js";

// Principal-dependent lints (agent-ancestry, pii-display-name) were removed
// by ADR-087. drift-uncovered-changes (ADR-090) joins the set.
export const SYSTEM_LINTS: Record<string, Lint> = {
  "orphan-reasoning": lintOrphanReasoning,
  "connectivity": lintConnectivity,
  "follows-cycle": lintFollowsCycle,
  "bugfix-guard": lintBugfixGuard,
  "drift-uncovered-changes": lintDriftUncoveredChanges,
};

export interface LintReport {
  total: number;
  errors: number;
  warnings: number;
  issuesByLint: Record<string, LintIssue[]>;
  issues: LintIssue[];
}

export function runAllLints(db: Database, ctx?: LintContext): LintReport {
  const issuesByLint: Record<string, LintIssue[]> = {};
  const all: LintIssue[] = [];
  for (const [name, lint] of Object.entries(SYSTEM_LINTS)) {
    const issues = lint(db, ctx);
    issuesByLint[name] = issues;
    all.push(...issues);
  }
  const errors = all.filter((i) => i.severity === "error").length;
  const warnings = all.filter((i) => i.severity === "warning").length;
  return { total: all.length, errors, warnings, issuesByLint, issues: all };
}
