// Scope-summary backfill (decision_01KRYECEA32SRSQCKFXSDCBK67).
//
// The "primary intent of a scope" pattern is gone — each scope's
// description text now lives on the Scope row's `summary` column (and
// is mirrored in `raw_yaml.summary`). This migration walks every scope
// on a Doco and:
//
//   1. If raw_yaml.intent_ids holds a single id, looks up that Intent's
//      summary text, writes it into Scope.summary, removes intent_ids
//      from the YAML, and marks the referenced Intent superseded.
//   2. If a default scope template (#global, #user-flows, etc.) has an
//      `allowed_node_types` value and the row doesn't, copies it onto
//      the row's YAML so the constitution's rules-only invariant takes
//      effect on existing Docos too.
//   3. If Scope.summary is still empty AND the matching template has a
//      summary, copies the template's summary in.
//
// Idempotent per Doco — gated on a `doco_meta` flag. Runs once per
// process per Doco, called from `loadBootstrapContext` alongside the
// scope-hashtag-prefix migration so every bootstrap read sees the new
// shape.

import { DEFAULT_SCOPE_TEMPLATES } from "@doco/host";
import { withTransaction } from "@doco/db";
import { parse as parseYaml } from "yaml";

const _migrated = new Set<string>();

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  try {
    const v = parseYaml(raw);
    if (v && typeof v === "object") return v as Record<string, unknown>;
  } catch {
    /* unparseable */
  }
  return null;
}

export async function ensureScopeSummaryMigration(docoId: string): Promise<void> {
  if (_migrated.has(docoId)) return;
  const key = `scope_summary_migration_${docoId}`;

  await withTransaction(async (c) => {
    const flag = await c.query<{ value: string }>(
      "SELECT value FROM doco_meta WHERE key = $1",
      [key],
    );
    if (flag.rows[0]?.value === "done") {
      _migrated.add(docoId);
      return;
    }

    const scopeRows = await c.query<{
      id: string;
      name: string;
      summary: string | null;
      raw_yaml: string;
    }>(
      "SELECT id, name, summary, raw_yaml FROM scopes WHERE doco_id = $1",
      [docoId],
    );

    for (const row of scopeRows.rows) {
      const fm = parseFrontmatter(row.raw_yaml) ?? {};
      let changed = false;
      let nextSummary = (row.summary ?? "").trim();
      // (1) Port any single primary-intent's text onto the scope row.
      const legacyIntentIds = Array.isArray(fm.intent_ids)
        ? (fm.intent_ids as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      if (legacyIntentIds.length > 0) {
        if (legacyIntentIds.length === 1) {
          const irow = await c.query<{ summary: string | null; raw_yaml: string }>(
            "SELECT summary, raw_yaml FROM intents WHERE id = $1 AND doco_id = $2 LIMIT 1",
            [legacyIntentIds[0], docoId],
          );
          const intent = irow.rows[0];
          if (intent) {
            const ported = (intent.summary ?? "").trim();
            const isBoilerplate =
              nextSummary === "" || nextSummary === `Scope: ${row.name}`;
            if (ported && isBoilerplate) {
              nextSummary = ported;
              changed = true;
            }
            // Supersede the now-redundant primary-intent Intent.
            const intentFm = parseFrontmatter(intent.raw_yaml) ?? {};
            intentFm.lifecycle = "superseded";
            await c.query(
              `UPDATE intents
                  SET lifecycle = 'superseded',
                      raw_yaml = $1,
                      updated_at = now()
                WHERE id = $2`,
              [JSON.stringify(intentFm), legacyIntentIds[0]],
            );
          }
        }
        delete fm.intent_ids;
        changed = true;
      }
      // (2) Copy template's allowed_node_types if the row is missing one.
      const template = DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === row.name);
      if (
        template?.allowed_node_types &&
        template.allowed_node_types.length > 0 &&
        !Array.isArray(fm.allowed_node_types)
      ) {
        fm.allowed_node_types = [...template.allowed_node_types];
        changed = true;
      }
      // (3) Fall back to template.summary when the row is still empty.
      if (
        template?.summary &&
        (nextSummary === "" || nextSummary === `Scope: ${row.name}`)
      ) {
        nextSummary = template.summary;
        changed = true;
      }
      if (changed) {
        if (nextSummary) fm.summary = nextSummary;
        await c.query(
          "UPDATE scopes SET summary = $1, raw_yaml = $2, updated_at = now() WHERE id = $3",
          [nextSummary || null, JSON.stringify(fm), row.id],
        );
      }
    }

    await c.query(
      "INSERT INTO doco_meta (key, value) VALUES ($1, 'done') " +
        "ON CONFLICT (key) DO UPDATE SET value = 'done'",
      [key],
    );
  });

  _migrated.add(docoId);
}
