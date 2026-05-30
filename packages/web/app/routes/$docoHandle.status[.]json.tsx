import { DOCO_NODE_TABLE_SPECS, withClient } from "@doco/db";
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
    visibility: meta.visibility,
    last_updated_at: latest,
    counts,
  });
}

/**
 * Per-table accessor for the status counts. `group` tells consumers
 * whether the table holds notes (domain nodes a Doco captures) or
 * policies. Keeping the two apart in the
 * response prevents callers from summing policies into a "node
 * total" — an empty Doco with only template policies would
 * otherwise misread as having captured work.
 */
type StatusGroup = "note" | "policy";
const TYPE_MAP: { entityType: string; table: string; plural: string; group: StatusGroup }[] = [
  ...DOCO_NODE_TABLE_SPECS.map((spec) => ({
    entityType: spec.entityType,
    table: spec.table,
    plural: spec.entityType === "reference" ? "references" : `${spec.table}`,
    group: "note" as const,
  })),
  {
    entityType: "guidance_policy",
    table: "guidance_policies",
    plural: "guidance_policies",
    group: "policy",
  },
  {
    entityType: "node_authoring_policy",
    table: "node_authoring_policies",
    plural: "node_authoring_policies",
    group: "policy",
  },
];

interface StatusCounts {
  notes: Record<string, number>;
  notes_total: number;
  policies: Record<string, number>;
  policies_total: number;
  principals: number;
}

function emptyCounts(): StatusCounts {
  const notes: Record<string, number> = {};
  const policies: Record<string, number> = {};
  for (const { plural, group } of TYPE_MAP) {
    if (group === "note") notes[plural] = 0;
    else policies[plural] = 0;
  }
  return { notes, notes_total: 0, policies, policies_total: 0, principals: 0 };
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
          counts.policies[plural] = n;
          counts.policies_total += n;
        }
        const ts = r.rows[0]?.c ?? null;
        if (ts && (latest === null || ts > latest)) latest = ts;
      }
      const p = await c.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM principals WHERE doco_id = $1",
        [docoId],
      );
      counts.principals = Number(p.rows[0]?.n ?? 0);
    });
  } catch {
    // emptyCounts() already zero-initialized everything.
  }
  return { latest, counts };
}
