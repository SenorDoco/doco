// v7 backfill (decision_01KRRR5BQ16ASY8HQEE0V499YG).
//
// The v7 framework drops `Rule.kind = "authoring"` in favor of an edge:
// a Scope cites its authoring rules via `Scope.gated_by`. Existing Doco
// rows still carry `kind: authoring` on Rules with no corresponding
// `gated_by` entry on the Scope side. This module rewrites them:
//
//   • For each Rule whose raw_yaml has `kind: authoring`:
//       - flip the rule's `kind` to `tagged`
//       - append the rule's id to each cited scope's `gated_by`
//   • Persist the rewritten YAML for both the rule and the scope.
//   • Record completion in `doco_meta` so it runs at most once per Doco.
//
// Gated on a per-Doco flag (`v7_gated_by_migration_<doco_id> = 'done'`)
// because each Doco's rules + scopes are independent; the migration is
// idempotent per Doco and a fresh Doco that never had `kind: authoring`
// rules will simply find nothing to migrate and mark itself done.
//
// Called from the capture path before `runScopeRules` reads any rule —
// guarantees the rule loader sees the new shape (Scope.gated_by) instead
// of relying on a transitional dual-read.

import { withTransaction } from "@doco/db";
import { parse as parseYaml } from "yaml";

const _migrated = new Set<string>();

/**
 * Parse raw_yaml — the column has historically held either JSON
 * (post-Phase-2 writers via `upsertEntity` which does
 * `JSON.stringify(fm)`) or YAML (file-importer path). `parseYaml`
 * handles both because YAML is a superset of JSON; we try JSON first
 * because it's the common shape and faster.
 */
function parseFrontmatter(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* fall through to YAML */
  }
  try {
    const v = parseYaml(raw);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* unparseable */
  }
  return null;
}

export async function ensureV7Migration(docoId: string): Promise<void> {
  if (_migrated.has(docoId)) return;

  const key = `v7_gated_by_migration_${docoId}`;

  await withTransaction(async (c) => {
    const flag = await c.query<{ value: string }>(
      "SELECT value FROM doco_meta WHERE key = $1",
      [key],
    );
    if (flag.rows[0]?.value === "done") return;

    const ruleRows = await c.query<{ id: string; raw_yaml: string }>(
      "SELECT id, raw_yaml FROM rules WHERE doco_id = $1",
      [docoId],
    );

    const scopeToRules = new Map<string, string[]>();
    const rulesToUpdate: { id: string; newYaml: string }[] = [];

    for (const r of ruleRows.rows) {
      const rec = parseFrontmatter(r.raw_yaml);
      if (!rec) continue;
      if (rec.kind !== "authoring") continue;

      const scopes = Array.isArray(rec.scopes)
        ? (rec.scopes as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      for (const s of scopes) {
        const arr = scopeToRules.get(s) ?? [];
        if (!arr.includes(r.id)) arr.push(r.id);
        scopeToRules.set(s, arr);
      }
      rec.kind = "tagged";
      rulesToUpdate.push({ id: r.id, newYaml: JSON.stringify(rec) });
    }

    for (const [scopeId, ruleIds] of scopeToRules) {
      const row = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM scopes WHERE id = $1 AND doco_id = $2",
        [scopeId, docoId],
      );
      if (!row.rows[0]) continue;
      const rec = parseFrontmatter(row.rows[0].raw_yaml);
      if (!rec) continue;
      const existing = Array.isArray(rec.gated_by)
        ? (rec.gated_by as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const merged = Array.from(new Set([...existing, ...ruleIds]));
      rec.gated_by = merged;
      await c.query(
        "UPDATE scopes SET raw_yaml = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(rec), scopeId],
      );
    }

    for (const r of rulesToUpdate) {
      await c.query(
        "UPDATE rules SET raw_yaml = $1, updated_at = now() WHERE id = $2",
        [r.newYaml, r.id],
      );
    }

    await c.query(
      "INSERT INTO doco_meta (key, value) VALUES ($1, 'done') " +
        "ON CONFLICT (key) DO UPDATE SET value = 'done'",
      [key],
    );
  });

  _migrated.add(docoId);
}
