// GitHub App callback after a user installs/updates the App. With "Request user
// authorization (OAuth) during installation" enabled, GitHub redirects here
// (GET) with ?installation_id=…&setup_action=…&state=…&code=….
//
// Only an owner of a GitHub organization can install the App there. Anyone
// else gets Request on GitHub's install page: GitHub emails the organization's
// owners and sends the person here with setup_action=request and no
// installation (or, for Install & request, with the installation of what they
// may install). Each Doco the state names then remembers the request, and what
// an owner installs on it lands there through the webhook
// (fulfillInstallationRequests).
//
// Nothing in that query string is trusted on its own:
//   - `state` must be one we signed (see buildInstallUrl) for the signed-in user;
//   - `code` is exchanged for the installing GitHub user's token, and the
//     installation must be one that user can access — otherwise any writer
//     could attach another organization's installation id and import its items.
// Then we record the installation as available to each Doco the state names
// and return to the page the install started from (`state.next`: the GitHub
// setup page or a Doco's GitHub page), where the user picks exactly which
// repos to connect: every repository of an organization, or the ones they
// want. Nothing is connected here.
import { getDocoByIdOrHandle, getUserById, roleAtLeast } from "@doco/db";
import { redirect } from "react-router";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import {
  exchangeInstallationCode,
  getInstallationAccount,
  listUserInstallationIds,
} from "~/lib/github-app.server";
import {
  recordInstallationAuthorization,
  recordInstallationRequest,
  verifyInstallState,
} from "~/lib/github-connection.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const state = verifyInstallState(url.searchParams.get("state") ?? "");
  if (!state) return redirect("/workspaces?github=setup_error");
  const back = (outcome: string) =>
    redirect(`${state.next}${state.next.includes("?") ? "&" : "?"}github=${outcome}`);

  const me = await getCurrentPrincipalAsync(request);
  if (!me) return back("signin_required");
  if (me.id !== state.userId) return back("forbidden");
  const docoIds: string[] = [];
  for (const docoId of state.docoIds) {
    const doco = await getDocoByIdOrHandle(docoId);
    if (!doco) return back("setup_error");
    const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
    if (!roleAtLeast(role, "writer")) return back("forbidden");
    docoIds.push(doco.id);
  }

  if (url.searchParams.get("setup_action") === "request") {
    const githubLogin = (await getUserById(me.id))?.github_login;
    if (githubLogin) {
      for (const docoId of docoIds) await recordInstallationRequest(docoId, githubLogin);
    }
    // Install & request: GitHub installed on what the person may install and
    // asked the owners for the rest, so the installation is recorded below too.
    if (!url.searchParams.get("installation_id")) return back("requested");
  }

  const installationId = Number(url.searchParams.get("installation_id"));
  if (!Number.isInteger(installationId) || installationId <= 0) return back("setup_error");
  const code = url.searchParams.get("code");
  if (!code) return back("authorization_required");

  try {
    const userToken = await exchangeInstallationCode(code);
    if (!(await listUserInstallationIds(userToken)).has(installationId)) {
      return back("installation_not_yours");
    }
    const { account, repository_selection } = await getInstallationAccount(installationId);
    const connectedAt = new Date().toISOString();
    for (const docoId of docoIds) {
      await recordInstallationAuthorization(docoId, {
        installation_id: installationId,
        account,
        ...(repository_selection ? { repository_selection } : {}),
        connected_at: connectedAt,
      });
    }
    return back("connected");
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key or client secret). Don't 500 the user — log and bounce back
    // with a message.
    console.error("[github setup] installation connect failed:", err);
    return back("setup_failed");
  }
}
