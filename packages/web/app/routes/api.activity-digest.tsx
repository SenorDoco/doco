// GET|POST /api/activity-digest — Vercel Cron, daily at 07:00 and 08:00 UTC,
// one of which is midnight Pacific Time whatever daylight saving says. At that
// one it emails each workspace's members the edition of its newspaper due
// that day: the daily one, and on Mondays the weekly one for who switched to
// it (lib/activity-digest.ts); at the other it sends nothing. A no-op until
// email is configured.
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
import { withClient } from "@doco/db";
import { sendActivityDigests } from "~/lib/activity-digest.server";
import { emailBaseUrl, emailConfigured } from "~/lib/email.server";

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
  const headers = { "Cache-Control": "no-store" };
  if (!emailConfigured()) return Response.json({ ok: true, skipped: "no_email" }, { headers });
  const result = await withClient((c) => sendActivityDigests(c, new Date(), emailBaseUrl()));
  return Response.json({ ok: true, ...result }, { headers });
}
