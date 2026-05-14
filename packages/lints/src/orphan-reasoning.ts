import type { PoolClient } from "pg";
import { parse as parseYaml } from "yaml";
import type { LintIssue } from "./types.js";

/**
 * Every Reasoning entity should have a conclusion_ref that resolves to a real
 * entity. Orphan Reasonings — no conclusion or pointing to nowhere — fail
 * this lint.
 */
export const lintOrphanReasoning = async (
  c: PoolClient,
  docoId: string,
): Promise<LintIssue[]> => {
  const issues: LintIssue[] = [];

  const rows = (
    await c.query<{ id: string; raw_yaml: string }>(
      `SELECT id, raw_yaml FROM reasoning WHERE doco_id = $1`,
      [docoId],
    )
  ).rows;

  for (const r of rows) {
    const ref = pickConclusionRef(r.raw_yaml);
    if (!ref) {
      issues.push({
        lintId: "orphan-reasoning",
        severity: "warning",
        source: r.id,
        message: "Reasoning has no conclusion_ref — orphan inference.",
      });
      continue;
    }
    if (!(await entityExists(c, docoId, ref))) {
      issues.push({
        lintId: "orphan-reasoning",
        severity: "error",
        source: r.id,
        message: `conclusion_ref ${ref} does not resolve to a known entity.`,
      });
    }
  }
  return issues;
};

function pickConclusionRef(rawYaml: string): string | null {
  try {
    const obj = parseYaml(rawYaml) as Record<string, unknown> | null;
    const v = obj?.conclusion_ref;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

const SCOPED_TABLES = [
  "decisions",
  "actions",
  "intents",
  "ideas",
  "rules",
  "reasoning",
  "evals",
  "reference_entities",
  "scopes",
] as const;

async function entityExists(
  c: PoolClient,
  docoId: string,
  id: string,
): Promise<boolean> {
  // principals live at host level (no doco_id). Try them first.
  const p = await c.query("SELECT 1 FROM principals WHERE id = $1 LIMIT 1", [id]);
  if ((p.rowCount ?? 0) > 0) return true;
  for (const t of SCOPED_TABLES) {
    const r = await c.query(
      `SELECT 1 FROM ${t} WHERE id = $1 AND doco_id = $2 LIMIT 1`,
      [id, docoId],
    );
    if ((r.rowCount ?? 0) > 0) return true;
  }
  return false;
}
