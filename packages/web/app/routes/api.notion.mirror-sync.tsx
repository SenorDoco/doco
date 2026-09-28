// /api/notion/mirror-sync — Vercel Cron, every minute: advance each Notion
// mirror's paced sync (discovery, reconcile, drain, users). See
// lib/notion-mirror-sync.server.ts. Mirrors run concurrently: the work is
// waiting on Notion, and rate limits are per connection.
//
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
//
// DOCO_NOTION_MIRROR_CALLS_PER_MINUTE (default 120, two-thirds of Notion's
// standard 180) is how many requests each mirror may make per tick; raise it
// toward 600 for a Business or Enterprise workspace.
import {
  DEFAULT_REQUESTS_PER_MINUTE,
  listActiveNotionMirrors,
  runNotionMirrorTick,
} from "~/lib/notion-mirror-sync.server";

// A tick's own deadline is 50 s so ticks never pile up; the ceiling matches
// the Slack sync route's margin.
export const config = { maxDuration: 300 };

export async function loader({ request }: { request: Request }) {
  return run(request);
}
export async function action({ request }: { request: Request }) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const requestsPerMinute =
    Number(process.env.DOCO_NOTION_MIRROR_CALLS_PER_MINUTE) || DEFAULT_REQUESTS_PER_MINUTE;
  const mirrors = await Promise.all(
    (await listActiveNotionMirrors()).map(async ({ docoId }) => {
      try {
        return { docoId, ...(await runNotionMirrorTick({ docoId, requestsPerMinute })) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[notion mirror-sync] ${docoId} failed:`, message);
        return { docoId, error: message };
      }
    }),
  );
  return Response.json({ ok: true, mirrors }, { headers: { "Cache-Control": "no-store" } });
}
