export interface LintIssue {
  lintId: string;
  severity: "error" | "warning";
  source: string; // entity id
  message: string;
}

import type { Database } from "better-sqlite3";
export type Lint = (db: Database) => LintIssue[];
