// GET|POST /api/activity/rollup — Vercel Cron, every hour. Counts the days of
// activity that have ended into activity_days, which the Activity calendars
// and top lists read (rollUpActivity in lib/activity-log.server.ts).
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
import { withTransaction } from "@doco/db";
import { rollUpActivity } from "~/lib/activity-log.server";

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
  const result = await withTransaction((c) => rollUpActivity(c));
  return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
