// v13 entity.scopes[] strip
// (decision_01KS3DW9C2KN2X7Z80R18H1RAX).
//
// Pre-v13 entities (Decision, Intent, Rule, Action, Log, Eval, Idea,
// Reference, State) carried a `scopes: [scope_<ulid>, …]` array in
// their raw_yaml. v13 removed scopes; the array is now meaningless
// cruft that confuses graph rendering and search-result enrichment.
//
// This module rewrites every entity row in every Doco to drop the
// `scopes` key from raw_yaml. Gated on a per-host flag
// (`v13_strip_entity_scopes = 'done'`) so it runs at most once;
// subsequent boots short-circuit. Idempotent — a row already
// missing the `scopes` key is a no-op.

import { withClient } from "@doco/db";
import { parse as parseYaml } from "yaml";

const ENTITY_TABLES = [
  "intents",
  "decisions",
  "rules",
  "actions",
  "logs",
  "evals",
  "ideas",
  "reference_entities",
  "states",
] as const;

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through to YAML */
  }
  try {
    const v = parseYaml(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* unparseable — caller treats as no-op */
  }
  return null;
}

let _migrated = false;

export async function ensureEntityScopesStripped(): Promise<void> {
  if (_migrated) return;
  await withClient(async (c) => {
    const meta = await c.query<{ value: string }>(
      "SELECT value FROM doco_meta WHERE key = 'v13_strip_entity_scopes' LIMIT 1",
    );
    if (meta.rows[0]?.value === "done") {
      _migrated = true;
      return;
    }
    for (const table of ENTITY_TABLES) {
      const rows = await c.query<{ id: string; raw_yaml: string }>(
        // Only fetch rows that look like they have a scopes key, to
        // avoid rewriting every row on every existing Doco.
        `SELECT id, raw_yaml FROM ${table}
          WHERE raw_yaml LIKE '%"scopes"%' OR raw_yaml LIKE '%scopes:%'`,
      );
      for (const row of rows.rows) {
        const fm = parseFrontmatter(row.raw_yaml);
        if (!fm || !("scopes" in fm)) continue;
        delete fm.scopes;
        await c.query(`UPDATE ${table} SET raw_yaml = $1 WHERE id = $2`, [
          JSON.stringify(fm),
          row.id,
        ]);
      }
    }
    await c.query(
      `INSERT INTO doco_meta (key, value) VALUES ('v13_strip_entity_scopes', 'done')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );
    _migrated = true;
  });
}
