// GitHub App callback after a user installs/updates the App. With "Request user
// authorization (OAuth) during installation" enabled, GitHub redirects here
// (GET) with ?installation_id=…&setup_action=…&state=…&code=….
//
// Nothing in that query string is trusted on its own:
//   - `state` must be one we signed (see buildInstallUrl) for the signed-in user;
//   - `code` is exchanged for the installing GitHub user's token, and the
//     installation must be one that user can access — otherwise any writer
//     could attach another organization's installation id and import its PRs.
// Then we record the installation as available to this Doco and return to the
// GitHub integration page, where the user picks exactly which repos to connect.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { redirect } from "react-router";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import {
  exchangeInstallationCode,
  getInstallationAccount,
  listUserInstallationIds,
} from "~/lib/github-app.server";
import {
  recordInstallationAuthorization,
  verifyInstallState,
} from "~/lib/github-connection.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const installationId = Number(url.searchParams.get("installation_id"));
  const state = verifyInstallState(url.searchParams.get("state") ?? "");
  if (!Number.isInteger(installationId) || installationId <= 0 || !state) {
    return redirect("/workspaces?github=setup_error");
  }

  const doco = await getDocoByIdOrHandle(state.docoId);
  if (!doco) return redirect("/workspaces?github=setup_error");

  // Land on the GitHub integration's detail page — that's where the import
  // progress banner and connection details live now (the /integrations index
  // only lists what's connected).
  const panel = `/${doco.handle}/integrations/github`;

  const me = await getCurrentPrincipalAsync(request);
  if (!me) return redirect(`${panel}?github=signin_required`);
  if (me.id !== state.userId) return redirect(`${panel}?github=forbidden`);
  const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
  if (!roleAtLeast(role, "writer")) return redirect(`${panel}?github=forbidden`);

  const code = url.searchParams.get("code");
  if (!code) return redirect(`${panel}?github=authorization_required`);

  try {
    const userToken = await exchangeInstallationCode(code);
    if (!(await listUserInstallationIds(userToken)).has(installationId)) {
      return redirect(`${panel}?github=installation_not_yours`);
    }
    const { account, repository_selection } = await getInstallationAccount(installationId);
    await recordInstallationAuthorization(doco.id, {
      installation_id: installationId,
      account,
      ...(repository_selection ? { repository_selection } : {}),
      connected_at: new Date().toISOString(),
    });
    return redirect(`${panel}?github=connected`);
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key or client secret). Don't 500 the user — log and bounce back
    // with a message.
    console.error("[github setup] installation connect failed:", err);
    return redirect(`${panel}?github=setup_failed`);
  }
}
