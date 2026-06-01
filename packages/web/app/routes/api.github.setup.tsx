// GitHub App "Setup URL" callback — GitHub redirects here (GET) right after a
// user installs/updates the App, with ?installation_id=…&setup_action=…&state=…
// (state = the Doco id/handle we sent in buildInstallUrl). We verify write
// access, connect every repo the installation covers, then kick the PR import
// off the request path (waitUntil) so a huge org (tens of thousands of PRs)
// doesn't block the redirect — the Integrations page shows an "importing in the
// background" banner. The import itself is a chain of time-budgeted slices
// (api.github.backfill-run) so even a tens-of-thousands-of-PRs org never hits
// the function timeout. New repos added later sync automatically via the webhook.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { redirect } from "react-router";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import {
  getDocoConnectionsContext,
  importInstallationConnections,
  setBackfillState,
} from "~/lib/github-connection.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";
import { kickBackfillRun } from "./api.github.backfill-run";

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
    const ctx = await getDocoConnectionsContext(doco.id);
    const { repos } = await importInstallationConnections({ docoId: doco.id, installationId });
    if (!ctx || repos.length === 0) {
      return redirect(`${panel}?github=connected&count=${repos.length}&imported=0`);
    }

    // Seed the resumable cursor and kick the first import slice off the request
    // path. The user lands on the Doco immediately and sees the "importing…"
    // banner; the worker chains slice-by-slice (api.github.backfill-run) until
    // the whole queue drains, so tens of thousands of PRs never block or time
    // out. The worker flips the marker to "done" when finished.
    await setBackfillState(doco.id, {
      status: "running",
      started_at: new Date().toISOString(),
      repos: repos.length,
      installation_id: installationId,
      queue: repos,
      repo_index: 0,
      page: 1,
      imported: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    waitUntil(kickBackfillRun(url.origin, doco.id));
    return redirect(`${panel}?github=importing&count=${repos.length}`);
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key). Don't 500 the user — log and bounce back with a message.
    console.error("[github setup] installation connect failed:", err);
    return redirect(`${panel}?github=setup_failed`);
  }
}
