// GET|POST /api/alerts/silence-check — Vercel Cron, every hour. Opens an alert
// for each integration Doco or agent gone unexpectedly quiet, closes the ones
// that spoke again (lib/silence-alerts.server.ts), and emails each new alert
// once to the people it concerns.
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
import { withClient } from "@doco/db";
import { emailBaseUrl } from "~/lib/email.server";
import { checkSilences, emailNewAlerts } from "~/lib/silence-alerts.server";

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
  const result = await withClient(async (c) => ({
    ...(await checkSilences(c)),
    ...(await emailNewAlerts(c, emailBaseUrl())),
  }));
  return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
