// A Doco's activity, as the side column of its home shows it: the Activity
// chart's count per day (nodes captured, and what the Doco copied from its
// source), the latest recorded writes, and who wrote and queried it most. A
// reader Doco (codebase, Notion) shows the same column beside whatever is open.
//
// Activity reflects nodes only: policies are Doco-level metadata with their
// own surface, and counting their bulk-imported writes here makes a fresh
// Doco look like work has been captured when none has.

import type { ActivityFeedLineItem } from "~/components/activity-feed-line";
import { HEATMAP_WEEKS } from "~/components/activity-heatmap";
import { NODE_TYPES_FOR_STATS_SQL, copiesByDay } from "./doco-stats.server";
import { TOP_ACTORS_LIMIT, type TopActor, listTopActors } from "./top-actors.server";

const FEED_LIMIT = 20;

export interface DocoFeedItem extends ActivityFeedLineItem {
  event_id: string;
}

export interface DocoActivity {
  /** How much happened each day of the chart's year, keyed by YYYY-MM-DD. */
  byDay: Record<string, number>;
  /** The latest recorded writes, newest first. */
  items: DocoFeedItem[];
  /** Who wrote to the Doco most, per person and agent. */
  topContributors: TopActor[];
  /** Who queried the Doco most, per person and agent. */
  topQueryers: TopActor[];
}

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

const iso = (at: Date | string) =>
  at instanceof Date ? at.toISOString() : new Date(String(at)).toISOString();

export async function loadDocoActivity(c: QueryClient, docoId: string): Promise<DocoActivity> {
  const rawItems = (
    await c.query<{
      event_id: string;
      at: Date | string;
      entity_type: string;
      entity_id: string;
      op: string;
      before_json: Record<string, unknown> | null;
      after_json: Record<string, unknown> | null;
    }>(
      `SELECT event_id, at, entity_type, entity_id, op, before_json, after_json
         FROM audit_events
        WHERE doco_id = $1
          AND entity_type NOT IN ('policy')
        ORDER BY at DESC
        LIMIT $2`,
      [docoId, FEED_LIMIT],
    )
  ).rows;

  const entityIds = Array.from(new Set(rawItems.map((r) => r.entity_id)));
  const entityById = new Map<string, { label: string | null; lifecycle: string | null }>();
  if (entityIds.length > 0) {
    const entityLabelRows = await c.query<{
      id: string;
      label: string | null;
      lifecycle: string | null;
    }>(
      // All node types live in `nodes`. Labels are the first line of
      // `prose`, except principals (prose='') label on `name`.
      // Policies keep their own tables and their `policy` column.
      `SELECT id,
              split_part(prose, E'\\n', 1) AS label,
              lifecycle
         FROM nodes
        WHERE doco_id = $1 AND id = ANY($2::text[])
          AND node_type IN ('decision', 'intent', 'idea', 'rule', 'action', 'log', 'eval', 'state', 'reference', 'principal')
       UNION ALL SELECT id, COALESCE(NULLIF(data->'predicate'->>'agent_instruction', ''), kind, 'policy') AS label, lifecycle FROM policies WHERE doco_id = $1 AND id = ANY($2::text[])`,
      [docoId, entityIds],
    );
    for (const row of entityLabelRows.rows) {
      entityById.set(row.id, { label: row.label, lifecycle: row.lifecycle });
    }
  }

  const items: DocoFeedItem[] = rawItems.map((it) => {
    const entity = entityById.get(it.entity_id);
    // Audit events carry prose under the type-named key for nodes
    // and `policy` for policies. The first non-empty line wins.
    const proseKey = it.entity_type;
    return {
      event_id: it.event_id,
      id: it.entity_id,
      entity_type: it.entity_type,
      summary:
        entity?.label ??
        firstLine(stringField(it.after_json, proseKey)) ??
        firstLine(stringField(it.before_json, proseKey)) ??
        stringField(it.after_json, "policy") ??
        stringField(it.before_json, "policy"),
      lifecycle: entity?.lifecycle ?? null,
      at: iso(it.at),
      op: it.op,
      before: it.before_json,
      after: it.after_json,
    };
  });

  const since = new Date();
  since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
  const sinceIso = since.toISOString();
  const activityRows = (
    await c.query<{ day: string; n: string }>(
      // Post-collapse: one scan of `nodes` over the 10 node types
      // (9 prose types + principals; no policies).
      `SELECT day, COUNT(*)::text AS n FROM (
         SELECT to_char(created_at, 'YYYY-MM-DD') AS day
           FROM nodes
          WHERE doco_id = $1
            AND node_type IN (${NODE_TYPES_FOR_STATS_SQL})
       ) t WHERE day >= $2
       GROUP BY day`,
      [docoId, sinceIso.slice(0, 10)],
    )
  ).rows;
  // What the Doco copied from its source is activity too.
  const byDay = await copiesByDay(c, [docoId], sinceIso);
  for (const r of activityRows) byDay[r.day] = (byDay[r.day] ?? 0) + Number(r.n);

  const scope = { docoIds: [docoId] };
  const topContributors = await listTopActors(c, "writes", scope, TOP_ACTORS_LIMIT);
  const topQueryers = await listTopActors(c, "queries", scope, TOP_ACTORS_LIMIT);

  return { byDay, items, topContributors, topQueryers };
}

function stringField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = obj?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstLine(value: string | null): string | null {
  if (!value) return null;
  const line = value.split("\n", 1)[0];
  return line ?? value;
}
