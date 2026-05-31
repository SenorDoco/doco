// GitHub App "Setup URL" callback — GitHub redirects here (GET) right after a
// user installs/updates the App, with ?installation_id=…&setup_action=…&state=…
// (state = the Doco id/handle we sent in buildInstallUrl). We verify the user
// has write access to that Doco, import the installation's repos as
// connections, and bounce back to the Integrations panel. No manual IDs.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { redirect } from "react-router";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { importInstallationConnections } from "~/lib/github-connection.server";
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

  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return redirect(`/${doco.handle}/settings/integrations?github=signin_required`);
  }
  const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
  if (!roleAtLeast(role, "writer")) {
    return redirect(`/${doco.handle}/settings/integrations?github=forbidden`);
  }

  try {
    const { repos } = await importInstallationConnections({ docoId: doco.id, installationId });
    return redirect(`/${doco.handle}/settings/integrations?github=connected&count=${repos.length}`);
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key). Don't 500 the user — log and bounce back with a message.
    console.error("[github setup] installation import failed:", err);
    return redirect(`/${doco.handle}/settings/integrations?github=setup_failed`);
  }
}
