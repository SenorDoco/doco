// /admin/purge-deleted-docos — Vercel-Cron-hit endpoint that hard-deletes
// Docos whose soft-delete tombstone (`docos.deleted_at`) has aged past the
// 30-day grace window. Deleting a Doco only stamps `deleted_at`; this sweep is
// what eventually removes it for good, cascading every node, edge, immutable
// history row, and grant via ON DELETE CASCADE.
//
// Auth mirrors admin.agent-health-cron: an authenticated `torrenegra` session
// (handy for a manual trigger) OR Vercel's signed cron request
// (`x-vercel-cron`) / `Authorization: Bearer <CRON_SECRET>`.

import { purgeDocosDeletedBefore } from "@doco/db";
import { redirect } from "react-router";
import { getCurrentPrincipal } from "~/lib/session.server";

/** A tombstoned Doco is retained this many days before the sweep purges it. */
export const DELETED_DOCO_RETENTION_DAYS = 30;

function isAuthorized(request: Request): boolean {
  const bearer = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET ?? "";
  if (secret && bearer && bearer === `Bearer ${secret}`) return true;
  // Vercel's cron-invoked requests carry this header too.
  if (request.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function loader({ request }: { request: Request }) {
  // Allow either a logged-in admin (for manual ad-hoc triggers) or a
  // properly-authenticated cron call.
  const me = await getCurrentPrincipal(request);
  const authed = (me && me.username === "torrenegra") || isAuthorized(request);
  if (!authed) {
    // Anonymous probes get a generic 404 so the endpoint's existence
    // isn't even revealed.
    if (!me) throw redirect("/sign-in");
    throw new Response("Not Found", { status: 404 });
  }

  const cutoff = new Date(Date.now() - DELETED_DOCO_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const purged = await purgeDocosDeletedBefore(cutoff);
  return Response.json(
    {
      retention_days: DELETED_DOCO_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
      purged_count: purged.length,
      purged,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
