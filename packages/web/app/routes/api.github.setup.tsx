// GitHub App "Setup URL" callback — GitHub redirects here (GET) right after a
// user installs/updates the App, with ?installation_id=…&setup_action=…&state=…
// (state = the Doco id/handle we sent in buildInstallUrl). We verify the user
// has write access to that Doco, connect every repo the installation covers,
// auto-backfill their PRs (no manual re-import), and bounce to the Integrations
// page. New repos added to the org later sync automatically via the webhook.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { redirect } from "react-router";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { backfillInstallationRepos } from "~/lib/github-backfill.server";
import {
  getDocoConnectionsContext,
  importInstallationConnections,
} from "~/lib/github-connection.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const installationId = Number(url.searchParams.get("installation_id"));
  const state = url.searchParams.get("state") ?? "";
  if (!Number.isInteger(installationId) || installationId <= 0 || !state) {
    return redirect("/dashboard?github=setup_error");
  }

  const doco = await getDocoByIdOrHandle(state);
  if (!doco) return redirect("/dashboard?github=setup_error");

  // Redirect straight to /integrations (not the legacy /settings/integrations,
  // which redirects and would drop the ?github=… flash).
  const panel = `/${doco.handle}/integrations`;

  const me = await getCurrentPrincipalAsync(request);
  if (!me) return redirect(`${panel}?github=signin_required`);
  const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
  if (!roleAtLeast(role, "writer")) return redirect(`${panel}?github=forbidden`);

  try {
    const ctx = await getDocoConnectionsContext(doco.id);
    const { repos } = await importInstallationConnections({ docoId: doco.id, installationId });
    // Connect once → import every repo's existing PRs automatically.
    const sync = ctx
      ? await backfillInstallationRepos({
          docoDir: docoPath(ctx.handle),
          docoId: doco.id,
          ownerSlug: ctx.orgHandle,
          docoSlug: ctx.handle,
          repos,
          installationId,
          createdByUserId: me.id,
        })
      : { repos: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
    return redirect(
      `${panel}?github=connected&count=${repos.length}&imported=${sync.created + sync.updated}`,
    );
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key). Don't 500 the user — log and bounce back with a message.
    console.error("[github setup] installation connect/backfill failed:", err);
    return redirect(`${panel}?github=setup_failed`);
  }
}
