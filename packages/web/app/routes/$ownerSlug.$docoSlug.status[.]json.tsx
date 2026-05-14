import { docoPath, openDocoDb } from "~/lib/db.server";
import { canAccessDoco } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

/**
 * /<owner>/<doco>/status.json — agent-polled freshness signal.
 *
 * Returns the Doco's latest modification time + light counts. Reads from
 * the SQLite cache (which is itself rebuilt from Postgres rows on every
 * reindex). No filesystem entity walks
 * (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
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
  const meta = readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ status: "unknown", owner_slug: ownerSlug, doco_slug: docoSlug }, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!await canAccessDoco(meta, me?.id ?? null)) {
    return Response.json({ status: "unknown", owner_slug: ownerSlug, doco_slug: docoSlug }, { status: 404 });
  }
  const { latest, counts } = readStatusFromCache(ownerSlug, docoSlug);
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

const TYPES = [
  "scope",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "eval",
  "reference",
  "principal",
];

function readStatusFromCache(
  ownerSlug: string,
  docoSlug: string,
): { latest: string | null; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let latest: string | null = null;
  try {
    const db = openDocoDb(ownerSlug, docoSlug);
    try {
      for (const t of TYPES) {
        try {
          const row = db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number };
          counts[`${t}s`] = Number(row.n ?? 0);
        } catch {
          counts[`${t}s`] = 0;
        }
        try {
          const ts = db.prepare(`SELECT max(created_at) AS c FROM ${t}`).get() as { c: string | null };
          if (typeof ts.c === "string" && (latest === null || ts.c > latest)) latest = ts.c;
        } catch {}
      }
    } finally {
      db.close();
    }
  } catch {
    // No cache yet — return zeros.
    for (const t of TYPES) counts[`${t}s`] = 0;
  }
  return { latest, counts };
}
