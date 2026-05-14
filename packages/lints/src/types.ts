import type { PoolClient } from "pg";

export interface LintIssue {
  lintId: string;
  severity: "error" | "warning";
  source: string; // entity id
  message: string;
}

/**
 * Optional per-run context for lints that need more than the DB.
 * `docoRoot` lets file-system / git-aware lints (like drift coverage) work.
 */
export interface LintContext {
  docoRoot?: string;
}

/**
 * Lint signature. Async PG-backed: each lint receives a connection
 * scoped to one Doco. Lints are read-only.
 */
export type Lint = (
  c: PoolClient,
  docoId: string,
  ctx?: LintContext,
) => Promise<LintIssue[]>;
