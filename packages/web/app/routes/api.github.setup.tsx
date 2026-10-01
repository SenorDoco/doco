// GitHub App callback after a user installs/updates the App. With "Request user
// authorization (OAuth) during installation" enabled, GitHub redirects here
// (GET) with ?installation_id=…&setup_action=…&state=…&code=….
//
// Nothing in that query string is trusted on its own:
//   - `state` must be one we signed (see buildInstallUrl) for the signed-in user;
//   - `code` is exchanged for the installing GitHub user's token, and the
//     installation must be one that user can access — otherwise any writer
//     could attach another organization's installation id and import its items.
// Then we record the installation as available to each Doco the state names
// and return to the page the install started from (`state.next`: the GitHub
// setup page or a Doco's GitHub page), where the user picks exactly which
// repos to connect. A workspace's one-click Connect GitHub (`state.connectAll`)
// picks for them: every repository the installation grants, and the
// organization as a whole, start importing before they're back.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { redirect } from "react-router";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import {
  exchangeInstallationCode,
  getInstallationAccount,
  listUserInstallationIds,
} from "~/lib/github-app.server";
import {
  connectPicked,
  listGitHubInstallationChoicesForDocos,
  pickConnections,
  recordInstallationAuthorization,
  verifyInstallState,
} from "~/lib/github-connection.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";
import { kickBackfillRun } from "./api.github.backfill-run";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const installationId = Number(url.searchParams.get("installation_id"));
  const state = verifyInstallState(url.searchParams.get("state") ?? "");
  if (!Number.isInteger(installationId) || installationId <= 0 || !state) {
    return redirect("/workspaces?github=setup_error");
  }
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
    if (!state.connectAll) return back("connected");
    const picked = pickConnections(await listGitHubInstallationChoicesForDocos(docoIds), {
      repos: [],
      installations: [String(installationId)],
    });
    if ("error" in picked) return back("setup_error");
    const origin = new URL(request.url).origin;
    for (const docoId of docoIds) {
      if (await connectPicked(docoId, picked)) waitUntil(kickBackfillRun(origin, docoId));
    }
    return back("importing");
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key or client secret). Don't 500 the user — log and bounce back
    // with a message.
    console.error("[github setup] installation connect failed:", err);
    return back("setup_failed");
  }
}
