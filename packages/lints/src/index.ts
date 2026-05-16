import type { PoolClient } from "pg";
import { lintAgentAncestry } from "./agent-ancestry.js";
import { lintConnectivity } from "./connectivity.js";
import { lintFollowsCycle } from "./follows-cycle.js";
import { lintPiiDisplayName } from "./pii-display-name.js";
import type { Lint, LintIssue } from "./types.js";

export * from "./types.js";
export {
  lintAgentAncestry,
  lintConnectivity,
  lintFollowsCycle,
  lintPiiDisplayName,
};

export const SYSTEM_LINTS: Record<string, Lint> = {
  connectivity: lintConnectivity,
  "follows-cycle": lintFollowsCycle,
  "agent-ancestry": lintAgentAncestry,
  "pii-display-name": lintPiiDisplayName,
};

export interface LintReport {
  total: number;
  errors: number;
  warnings: number;
  issuesByLint: Record<string, LintIssue[]>;
  issues: LintIssue[];
}

export async function runAllLints(c: PoolClient, docoId: string): Promise<LintReport> {
  const issuesByLint: Record<string, LintIssue[]> = {};
  const all: LintIssue[] = [];
  for (const [name, lint] of Object.entries(SYSTEM_LINTS)) {
    const issues = await lint(c, docoId);
    issuesByLint[name] = issues;
    all.push(...issues);
  }
  const errors = all.filter((i) => i.severity === "error").length;
  const warnings = all.filter((i) => i.severity === "warning").length;
  return { total: all.length, errors, warnings, issuesByLint, issues: all };
}
