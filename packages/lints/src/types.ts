export interface LintIssue {
  lintId: string;
  severity: "error" | "warning";
  source: string; // entity id
  message: string;
}

import type { Database } from "better-sqlite3";

/**
 * Optional per-run context for lints that need more than the cache.
 * `docoRoot` lets file-system / git-aware lints (like drift coverage) work.
 */
export interface LintContext {
  docoRoot?: string;
}

export type Lint = (db: Database, ctx?: LintContext) => LintIssue[];
