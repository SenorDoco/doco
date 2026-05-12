import type { Database } from "better-sqlite3";
import { lintAgentAncestry } from "./agent-ancestry.js";
import { lintBugfixGuard } from "./bugfix-guard.js";
import { lintConnectivity } from "./connectivity.js";
import { lintDriftUncoveredChanges } from "./drift-uncovered-changes.js";
import { lintFollowsCycle } from "./follows-cycle.js";
import { lintOrphanReasoning } from "./orphan-reasoning.js";
import { lintPiiDisplayName } from "./pii-display-name.js";
import type { Lint, LintContext, LintIssue } from "./types.js";

export * from "./types.js";
export {
  lintAgentAncestry,
  lintBugfixGuard,
  lintConnectivity,
  lintDriftUncoveredChanges,
  lintFollowsCycle,
  lintOrphanReasoning,
  lintPiiDisplayName,
};
export { computeCoverage } from "./coverage.js";
export type { CoverageOptions, CoverageReport } from "./coverage.js";

export const SYSTEM_LINTS: Record<string, Lint> = {
  "orphan-reasoning": lintOrphanReasoning,
  "connectivity": lintConnectivity,
  "follows-cycle": lintFollowsCycle,
  "agent-ancestry": lintAgentAncestry,
  "bugfix-guard": lintBugfixGuard,
  "pii-display-name": lintPiiDisplayName,
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
