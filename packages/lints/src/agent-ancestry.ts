import type { Database } from "better-sqlite3";
import type { LintIssue } from "./types.js";

/**
 * Every agent Principal's owner_id chain must terminate at a `type: person`
 * Principal in a finite number of steps (PLANNING.md §3.4 / D-035 / R-04).
 *
 * Walks each agent's chain, depth-bounded at 100 to catch cycles.
 */
export const lintAgentAncestry = (db: Database): LintIssue[] => {
  const issues: LintIssue[] = [];

  const agents = db
    .prepare("SELECT id, owner_id FROM principal WHERE type = 'agent'")
    .all() as { id: string; owner_id: string | null }[];

  const lookup = db.prepare("SELECT type, owner_id FROM principal WHERE id = ?");

  for (const a of agents) {
    let cur = a.owner_id;
    let depth = 0;
    const seen = new Set<string>([a.id]);
    let resolved: "person" | "cycle" | "missing" | "no-owner" = "no-owner";
    while (cur) {
      if (seen.has(cur)) {
        resolved = "cycle";
        break;
      }
      seen.add(cur);
      depth += 1;
      if (depth > 100) {
        resolved = "cycle"; // depth bound — suspicious
        break;
      }
      const owner = lookup.get(cur) as { type: string; owner_id: string | null } | undefined;
      if (!owner) {
        resolved = "missing";
        break;
      }
      if (owner.type === "person") {
        resolved = "person";
        break;
      }
      cur = owner.owner_id;
    }

    if (resolved !== "person") {
      issues.push({
        lintId: "agent-ancestry",
        severity: "error",
        source: a.id,
        message: `Agent ancestry chain does not terminate at a person (${resolved}).`,
      });
    }
  }
  return issues;
};
