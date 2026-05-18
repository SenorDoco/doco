// Scope hashtag-prefix backfill.
//
// Scopes now carry a hashtag-shaped canonical name (`#global`,
// `#user-flows`, `#payments`). Existing rows from before the rename
// still carry bare names (`global`, `user-flows`). This migration
// prepends `#` to every scope whose name doesn't already start with
// `#`, updating both the indexed `scopes.name` column and the
// embedded `name` field inside `raw_yaml`.
//
// Idempotent per Doco — gated on a `doco_meta` flag so a fresh Doco
// (or a Doco that's already been migrated) skips the work.
//
// Runs once per Doco, before any capture path reads scope rows; called
// from `capture.server.ts` alongside `ensureV7Migration`.

import { withTransaction } from "@doco/db";
import { parse as parseYaml } from "yaml";

const _migrated = new Set<string>();

/**
 * Parse raw_yaml — historically held either JSON (post-Phase-2 writers
 * via `JSON.stringify`) or YAML (file-importer path). Try JSON first
 * because it's the common shape; fall back to YAML.
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

export async function ensureScopeHashtagPrefixMigration(docoId: string): Promise<void> {
  if (_migrated.has(docoId)) return;

  const key = `scope_hashtag_prefix_migration_${docoId}`;

  await withTransaction(async (c) => {
    const flag = await c.query<{ value: string }>(
      "SELECT value FROM doco_meta WHERE key = $1",
      [key],
    );
    if (flag.rows[0]?.value === "done") {
      _migrated.add(docoId);
      return;
    }

    const scopeRows = await c.query<{ id: string; name: string; raw_yaml: string }>(
      "SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1",
      [docoId],
    );

    for (const r of scopeRows.rows) {
      if (r.name.startsWith("#")) continue;

      const newName = `#${r.name}`;
      const fm = parseFrontmatter(r.raw_yaml);
      let newYaml = r.raw_yaml;
      if (fm) {
        if (typeof fm.name === "string" && !fm.name.startsWith("#")) {
          fm.name = `#${fm.name}`;
        }
        // The auto-generated summary "Scope: <name>" leaks the bare
        // name too. Refresh it iff it still matches the generated
        // pattern; otherwise leave human-authored summaries alone.
        if (typeof fm.summary === "string" && fm.summary === `Scope: ${r.name}`) {
          fm.summary = `Scope: ${newName}`;
        }
        newYaml = JSON.stringify(fm);
      }

      await c.query(
        "UPDATE scopes SET name = $1, raw_yaml = $2, updated_at = now() WHERE id = $3",
        [newName, newYaml, r.id],
      );

      // The auto-generated summary is also stored in its own column.
      await c.query(
        "UPDATE scopes SET summary = $1 WHERE id = $2 AND summary = $3",
        [`Scope: ${newName}`, r.id, `Scope: ${r.name}`],
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
