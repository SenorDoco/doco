import { withClient } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { canReadDocoForRequest, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/doco-metadata.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

/**
 * /<doco-handle>/status.json — agent-polled freshness signal.
 *
 * Returns the Doco's latest modification time + light counts read straight
 * from Postgres.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle } = await normalizeDocoParams(params);
  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ status: "unknown", doco_handle: handle }, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!(await canReadDocoForRequest(request, meta, me?.id ?? null))) {
    return Response.json({ status: "unknown", doco_handle: handle }, { status: 404 });
  }
  const { latest, counts } = await readStatusFromPg(meta.docoId);
  return Response.json({
    status: "ok" as const,
    doco_id: meta.docoId,
    doco_handle: meta.handle,
    display_name: meta.displayName || meta.handle,
    visibility: meta.visibility,
    last_updated_at: latest,
    counts,
  });
}

/**
 * Per-table accessor for the status counts. `group` tells consumers
 * whether the table holds notes (domain neurons a Doco captures) or
 * primitives (constitution metadata). Keeping the two apart in the
 * response prevents callers from summing primitives into a "neuron
 * total" — an empty Doco with only a template constitution would
 * otherwise misread as having captured work.
 */
type StatusGroup = "note" | "primitive";
const TYPE_MAP: { entityType: string; table: string; plural: string; group: StatusGroup }[] = [
  { entityType: "intent", table: "intents", plural: "intents", group: "note" },
  { entityType: "idea", table: "ideas", plural: "ideas", group: "note" },
  { entityType: "rule", table: "rules", plural: "rules", group: "note" },
  {
    entityType: "guidance_primitive",
    table: "guidance_primitives",
    plural: "guidance_primitives",
    group: "primitive",
  },
  {
    entityType: "neuron_authoring_primitive",
    table: "neuron_authoring_primitives",
    plural: "neuron_authoring_primitives",
    group: "primitive",
  },
  { entityType: "decision", table: "decisions", plural: "decisions", group: "note" },
  { entityType: "action", table: "actions", plural: "actions", group: "note" },
  { entityType: "log", table: "logs", plural: "logs", group: "note" },
  { entityType: "eval", table: "evals", plural: "evals", group: "note" },
  { entityType: "reference", table: "reference_entities", plural: "references", group: "note" },
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State node type.
  { entityType: "state", table: "states", plural: "states", group: "note" },
];

interface StatusCounts {
  notes: Record<string, number>;
  notes_total: number;
  articles: Record<string, number>;
  articles_total: number;
  principals: number;
}

function emptyCounts(): StatusCounts {
  const notes: Record<string, number> = {};
  const articles: Record<string, number> = {};
  for (const { plural, group } of TYPE_MAP) {
    if (group === "note") notes[plural] = 0;
    else articles[plural] = 0;
  }
  return { notes, notes_total: 0, articles, articles_total: 0, principals: 0 };
}

async function readStatusFromPg(
  docoId: string,
): Promise<{ latest: string | null; counts: StatusCounts }> {
  const counts = emptyCounts();
  let latest: string | null = null;
  try {
    await withClient(async (c) => {
      for (const { table, plural, group } of TYPE_MAP) {
        const r = await c.query<{ n: string; c: string | null }>(
          `SELECT COUNT(*)::text AS n, MAX(created_at)::text AS c FROM ${table} WHERE doco_id = $1`,
          [docoId],
        );
        const n = Number(r.rows[0]?.n ?? 0);
        if (group === "note") {
          counts.notes[plural] = n;
          counts.notes_total += n;
        } else {
          counts.articles[plural] = n;
          counts.articles_total += n;
        }
        const ts = r.rows[0]?.c ?? null;
        if (ts && (latest === null || ts > latest)) latest = ts;
      }
      // Principals are host-level (no doco_id) — count them globally.
      const p = await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM principals`);
      counts.principals = Number(p.rows[0]?.n ?? 0);
    });
  } catch {
    // emptyCounts() already zero-initialized everything.
  }
  return { latest, counts };
}
