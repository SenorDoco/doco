import { withClient } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { canAccessDoco } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

/**
 * /<owner>/<doco>/status.json — agent-polled freshness signal.
 *
 * Returns the Doco's latest modification time + light counts read straight
 * from Postgres.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json(
      { status: "unknown", owner_slug: ownerSlug, doco_slug: docoSlug },
      { status: 404 },
    );
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!(await canAccessDoco(meta, me?.id ?? null))) {
    return Response.json(
      { status: "unknown", owner_slug: ownerSlug, doco_slug: docoSlug },
      { status: 404 },
    );
  }
  const { latest, counts } = await readStatusFromPg(meta.docoId);
  return Response.json({
    status: "ok" as const,
    owner_slug: ownerSlug,
    doco_slug: docoSlug,
    doco_id: meta.docoId,
    display_name: meta.displayName || docoSlug,
    visibility: meta.visibility,
    last_updated_at: latest,
    counts,
  });
}

/** Map of external node_type → (PG table, exposed plural key for the response counts). */
const TYPE_MAP: { nodeType: string; table: string; plural: string }[] = [
  { nodeType: "scope", table: "scopes", plural: "scopes" },
  { nodeType: "intent", table: "intents", plural: "intents" },
  { nodeType: "idea", table: "ideas", plural: "ideas" },
  { nodeType: "rule", table: "rules", plural: "rules" },
  { nodeType: "decision", table: "decisions", plural: "decisions" },
  { nodeType: "action", table: "actions", plural: "actions" },
  { nodeType: "eval", table: "evals", plural: "evals" },
  { nodeType: "reference", table: "reference_entities", plural: "references" },
];

async function readStatusFromPg(
  docoId: string,
): Promise<{ latest: string | null; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  let latest: string | null = null;
  try {
    await withClient(async (c) => {
      for (const { table, plural } of TYPE_MAP) {
        const r = await c.query<{ n: string; c: string | null }>(
          `SELECT COUNT(*)::text AS n, MAX(created_at)::text AS c FROM ${table} WHERE doco_id = $1`,
          [docoId],
        );
        counts[plural] = Number(r.rows[0]?.n ?? 0);
        const ts = r.rows[0]?.c ?? null;
        if (ts && (latest === null || ts > latest)) latest = ts;
      }
      // Principals are host-level (no doco_id) — count them globally.
      const p = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM principals`,
      );
      counts.principals = Number(p.rows[0]?.n ?? 0);
    });
  } catch {
    for (const { plural } of TYPE_MAP) counts[plural] = 0;
    counts.principals = 0;
  }
  return { latest, counts };
}
