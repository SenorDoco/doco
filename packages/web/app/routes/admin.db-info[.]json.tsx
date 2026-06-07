// /admin/db-info.json — owner-only: where does THIS running process connect?
//
// Reports the live database location parsed from the connection string the
// pool actually uses (DOCO_DATABASE_URL / DATABASE_URL, with the local-dev
// fallback), with the password REDACTED. Answers "which Neon project/branch is
// production pointed at?" straight from the deployed runtime — more reliable
// than the dashboard, which shows what's *configured*, not what *resolved*.
//
// Auth: gated to `torrenegra`, same as the other /admin/*.json surfaces, so
// the deployment's infra details don't leak to anonymous probes.

import { redirect } from "react-router";

import { getDatabaseLocation } from "~/lib/db-info.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent("/admin/db-info.json")}`);
  if (me.username !== "torrenegra") {
    throw new Response("Not Found", { status: 404 });
  }
  return Response.json(getDatabaseLocation(), {
    headers: { "Cache-Control": "no-store" },
  });
}
