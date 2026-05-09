import type { Database } from "better-sqlite3";
import { lintAgentAncestry } from "./agent-ancestry.js";
import { lintBugfixGuard } from "./bugfix-guard.js";
import { lintOrphanReasoning } from "./orphan-reasoning.js";
import { lintPiiDisplayName } from "./pii-display-name.js";
import type { Lint, LintIssue } from "./types.js";

export * from "./types.js";
export { lintAgentAncestry, lintBugfixGuard, lintOrphanReasoning, lintPiiDisplayName };

export const SYSTEM_LINTS: Record<string, Lint> = {
  "orphan-reasoning": lintOrphanReasoning,
  "agent-ancestry": lintAgentAncestry,
  "bugfix-guard": lintBugfixGuard,
  "pii-display-name": lintPiiDisplayName,
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
