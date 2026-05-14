import type { PoolClient } from "pg";
import type { LintIssue } from "./types.js";

/**
 * Every agent Principal's owner_id chain must terminate at a `type: person`
 * Principal in a finite number of steps (PLANNING.md §3.4 / D-035 / R-04).
 *
 * Principals are host-level (no doco_id) — the check is global.
 *
 * Walks each agent's chain, depth-bounded at 100 to catch cycles.
 */
export const lintAgentAncestry = async (
  c: PoolClient,
  _docoId: string,
): Promise<LintIssue[]> => {
  const issues: LintIssue[] = [];

  const agents = (
    await c.query<{ id: string; owner_id: string | null }>(
      `SELECT id, owner_id FROM principals WHERE type = 'agent'`,
    )
  ).rows;

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
        resolved = "cycle";
        break;
      }
      const r = await c.query<{ type: string; owner_id: string | null }>(
        `SELECT type, owner_id FROM principals WHERE id = $1`,
        [cur],
      );
      const owner = r.rows[0];
      if (!owner) {
        resolved = "missing";
        break;
      }
      // PG schema uses 'human' for person principals.
      if (owner.type === "human" || owner.type === "person") {
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
