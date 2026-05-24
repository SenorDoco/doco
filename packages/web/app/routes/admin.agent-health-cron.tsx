// /admin/agent-health-cron — Vercel-Cron-hit endpoint that runs a
// health check and, if anything is warning/critical, POSTs the
// snapshot to whatever URL `DOCO_HEALTH_WEBHOOK_URL` points at.
//
// Auth: Vercel signs cron-invoked requests with a known header
// (`x-vercel-cron`), and the env var `CRON_SECRET` (per Vercel docs)
// gates the path against random callers. We accept either an
// authenticated `torrenegra` session (handy for manual triggers) OR
// a request carrying the `Authorization: Bearer <CRON_SECRET>`
// header that Vercel attaches when invoking from the dashboard's
// cron schedule.
//
// When DOCO_HEALTH_WEBHOOK_URL is unset, the endpoint still runs the
// check and returns the snapshot — useful for testing the cron
// wiring without committing a destination yet.

import { redirect } from "react-router";
import { type HealthSnapshot, getAgentHealth } from "~/lib/agent-health.server";
import { getCurrentPrincipal } from "~/lib/session.server";

function isAuthorized(request: Request): boolean {
  const bearer = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET ?? "";
  if (secret && bearer && bearer === `Bearer ${secret}`) return true;
  // Vercel's cron-invoked requests carry this header too.
  if (request.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

async function postWebhookAlert(
  snapshot: HealthSnapshot,
): Promise<{ posted: boolean; status?: number; error?: string }> {
  const url = process.env.DOCO_HEALTH_WEBHOOK_URL ?? "";
  if (!url) return { posted: false };
  try {
    // Generic JSON shape compatible with most webhook receivers
    // (Slack/Discord-style, or a custom listener). Slack incoming
    // webhooks accept `{ text, attachments }`; Discord likewise. A
    // plain receiver just gets the full snapshot under `snapshot`.
    const failing = snapshot.signals.filter((s) => s.severity !== "ok");
    const headline = `🔮 Doco agent health: ${snapshot.status.toUpperCase()} — ${failing.length} failing signal${failing.length === 1 ? "" : "s"}`;
    const body = JSON.stringify({
      text: headline,
      snapshot,
      summary: failing.map((s) => `${s.label}: ${s.detail}`),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { posted: true, status: res.status };
  } catch (err) {
    return { posted: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function loader({ request }: { request: Request }) {
  // Allow either a logged-in admin (for manual ad-hoc triggers) or
  // a properly-authenticated cron call.
  const me = await getCurrentPrincipal(request);
  const authed = (me && me.username === "torrenegra") || isAuthorized(request);
  if (!authed) {
    // Anonymous probes get a generic 404 so the endpoint's
    // existence isn't even revealed.
    if (!me) throw redirect("/sign-in");
    throw new Response("Not Found", { status: 404 });
  }

  const snapshot = await getAgentHealth();
  // Only POST when something is non-OK. Saves a lot of noise.
  const alert = snapshot.status === "ok" ? { posted: false } : await postWebhookAlert(snapshot);
  return Response.json(
    {
      snapshot,
      alert,
      webhook_configured: Boolean(process.env.DOCO_HEALTH_WEBHOOK_URL),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
