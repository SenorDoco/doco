// /admin/agent-health.json — current health snapshot as JSON.
//
// Same data the /admin/agent-usage page renders at the top; this
// route lets an uptime checker (UptimeRobot, BetterStack, Vercel
// Cron, curl in a loop) hit one URL and parse a status field.
//
// Auth: gated to the `torrenegra` user, like the dashboard.
// Re-using the same gate so the health surface doesn't leak details
// about the deployment to anonymous probes — that's a deliberate
// trade-off; if you want a public 200/503 ping, route through Vercel
// Cron + the internal-only webhook in admin.agent-health-cron.

import { redirect } from "react-router";
import { getAgentHealth } from "~/lib/agent-health.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent("/admin/agent-health.json")}`);
  if (me.username !== "torrenegra") {
    throw new Response("Not Found", { status: 404 });
  }
  const snapshot = await getAgentHealth();
  // 200 when OK, 503 when critical so a dumb uptime check that
  // looks only at HTTP status still notices outages without
  // parsing JSON. Warnings stay 200 (not "down", just "watch").
  const status = snapshot.status === "critical" ? 503 : 200;
  return Response.json(snapshot, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
