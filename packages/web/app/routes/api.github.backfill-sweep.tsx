// /api/github/backfill-sweep — durability net for the self-chaining PR import.
//
// The import advances by each slice re-triggering the next via waitUntil. That
// chain is best-effort: a single dropped re-kick (a transient 5xx, a cold
// start, a slice killed mid-run) strands the Doco at status:"running" forever —
// the list "never finishes." Markers written before the resumable driver
// shipped have no cursor at all and are likewise stuck.
//
// This endpoint — meant to run on a Vercel Cron schedule (every few minutes) —
// finds every "running" backfill whose cursor heartbeat (cursor_at) has gone
// stale and re-kicks its worker. The worker resumes from the saved cursor (or
// rebuilds the queue from connections for an old marker), so a stranded import
// self-heals on the next tick. Re-kicking a still-live chain can't happen: a
// healthy slice persists every <200s, well under the staleness cutoff.
//
// Auth mirrors the worker: the shared bearer secret (Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>`).
import { waitUntil } from "@vercel/functions";
import { findStaleRunningBackfills } from "~/lib/github-connection.server";
import { backfillRunSecret, kickBackfillRun } from "./api.github.backfill-run";

// Match the worker's budget so a sweep that fans out re-kicks to many stranded
// Docos has room to fire them all before the function ends.
export const config = { maxDuration: 300 };

/** Minutes a "running" cursor may sit without advancing before it's swept. Far
 *  above the 200s slice budget so only genuinely stranded chains are re-kicked. */
const STALE_MINUTES = 5;

function isAuthorized(request: Request): boolean {
  const secret = backfillRunSecret();
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true;
  return false;
}

export async function loader({ request }: { request: Request }) {
  return run(request);
}
export async function action({ request }: { request: Request }) {
  return run(request);
}

async function run(request: Request) {
  if (!isAuthorized(request)) return new Response("Forbidden", { status: 403 });

  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  const docoIds = await findStaleRunningBackfills(staleBefore);
  if (docoIds.length > 0) {
    console.info(`[github backfill-sweep] re-kicking ${docoIds.length} stranded backfill(s)`);
  }
  const origin = new URL(request.url).origin;
  for (const docoId of docoIds) {
    waitUntil(kickBackfillRun(origin, docoId));
  }
  return Response.json({ ok: true, swept: docoIds.length, doco_ids: docoIds });
}
