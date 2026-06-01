// /api/github/backfill-run — the self-chaining PR-import worker.
//
// Importing an org with tens of thousands of PRs can't finish inside one
// Vercel function invocation (the ~5000-PR wall hit in practice; `waitUntil`
// is still bounded by maxDuration). So the import is driven as a chain of
// time-budgeted SLICES: this endpoint runs ONE slice from the Doco's saved
// cursor, persists progress, and — if the queue isn't drained — re-triggers
// itself off the request path (waitUntil) to run the next slice. Every upsert
// is idempotent (keyed on the PR URL), so a dropped slice just re-runs from the
// last persisted cursor.
//
// Auth: a shared bearer secret (CRON_SECRET, falling back to the webhook
// secret) or Vercel's cron header — the same gate the health cron uses. The
// setup callback kicks the first slice with this secret; each slice re-kicks
// the next with it.
import { waitUntil } from "@vercel/functions";
import { docoPath } from "~/lib/db.server";
import { runBackfillSlice } from "~/lib/github-backfill-driver.server";
import { getDocoConnectionsContext } from "~/lib/github-connection.server";

/** Bearer secret the slices authenticate to each other with. */
export function backfillRunSecret(): string {
  return process.env.CRON_SECRET || process.env.DOCO_GITHUB_WEBHOOK_SECRET || "";
}

function isAuthorized(request: Request): boolean {
  const secret = backfillRunSecret();
  const bearer = request.headers.get("authorization");
  if (secret && bearer === `Bearer ${secret}`) return true;
  if (request.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

/**
 * Fire-and-forget POST to the backfill worker for `docoId`. Used by the setup
 * callback to kick the first slice and by the worker to chain the next. Returns
 * the (unawaited) fetch promise so callers can hand it to `waitUntil`.
 */
export function kickBackfillRun(origin: string, docoId: string): Promise<unknown> {
  return fetch(`${origin}/api/github/backfill-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backfillRunSecret()}`,
    },
    body: JSON.stringify({ docoId }),
  }).catch((err) => {
    console.error("[github backfill-run] self-kick failed:", err);
  });
}

export async function action({ request }: { request: Request }) {
  if (!isAuthorized(request)) return new Response("Forbidden", { status: 403 });

  let docoId = "";
  try {
    const body = (await request.json()) as { docoId?: unknown };
    if (typeof body.docoId === "string") docoId = body.docoId;
  } catch {
    /* fall through to the missing-docoId guard */
  }
  if (!docoId) return Response.json({ error: "docoId required" }, { status: 400 });

  const ctx = await getDocoConnectionsContext(docoId);
  if (!ctx) return Response.json({ error: "doco not found" }, { status: 404 });

  const marker = ctx.backfill;
  // No work queued, or the previous run already finished — nothing to do. This
  // makes a stray re-kick a harmless no-op rather than a re-import.
  if (!marker || marker.status === "done" || !marker.queue?.length) {
    return Response.json({ done: true, skipped: true });
  }

  const installationId = marker.installation_id ?? ctx.connections[0]?.installation_id ?? 0;

  const { done } = await runBackfillSlice(marker, {
    docoId,
    docoDir: docoPath(ctx.handle),
    ownerSlug: ctx.orgHandle,
    docoSlug: ctx.handle,
    installationId,
  });

  // More slices remain — re-trigger ourselves off the request path so the
  // whole org drains across as many invocations as it takes, each well within
  // the function timeout.
  if (!done) {
    waitUntil(kickBackfillRun(new URL(request.url).origin, docoId));
  }
  return Response.json({ done });
}
