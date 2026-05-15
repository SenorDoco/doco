import type { PoolClient } from "pg";

export interface LintIssue {
  lintId: string;
  severity: "error" | "warning";
  source: string; // entity id
  message: string;
}

/**
 * Lint signature. Async PG-backed: each lint receives a connection
 * scoped to one Doco. Lints are read-only.
 */
export type Lint = (c: PoolClient, docoId: string) => Promise<LintIssue[]>;
