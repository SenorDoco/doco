// GitHub App "Setup URL" callback — GitHub redirects here (GET) right after a
// user installs/updates the App, with ?installation_id=…&setup_action=…&state=…
// (state = the Doco id/handle we sent in buildInstallUrl). We verify write
// access, record the GitHub installation as available to this Doco, then return
// to the GitHub integration page where the user picks exactly which repositories
// to connect.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { redirect } from "react-router";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { getInstallationAccount } from "~/lib/github-app.server";
import { recordInstallationAuthorization } from "~/lib/github-connection.server";
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

  // Land on the GitHub integration's detail page — that's where the import
  // progress banner and connection details live now (the /integrations index
  // only lists what's connected).
  const panel = `/${doco.handle}/integrations/github`;

  const me = await getCurrentPrincipalAsync(request);
  if (!me) return redirect(`${panel}?github=signin_required`);
  const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
  if (!roleAtLeast(role, "writer")) return redirect(`${panel}?github=forbidden`);

  try {
    const { account } = await getInstallationAccount(installationId);
    await recordInstallationAuthorization(doco.id, {
      installation_id: installationId,
      account,
      connected_at: new Date().toISOString(),
    });
    return redirect(`${panel}?github=connected`);
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key). Don't 500 the user — log and bounce back with a message.
    console.error("[github setup] installation connect failed:", err);
    return redirect(`${panel}?github=setup_failed`);
  }
}
