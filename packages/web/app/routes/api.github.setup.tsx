// GitHub App "Setup URL" callback — GitHub redirects here (GET) right after a
// user installs/updates the App, with ?installation_id=…&setup_action=…&state=…
// (state = the Doco id/handle we sent in buildInstallUrl). We verify write
// access, connect every repo the installation covers, then kick the PR import
// off the request path (waitUntil) so a huge org (tens of thousands of PRs)
// doesn't block the redirect — the Integrations page shows an "importing in the
// background" banner. New repos added later sync automatically via the webhook.
import { getDocoByIdOrHandle, roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { redirect } from "react-router";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { backfillInstallationRepos } from "~/lib/github-backfill.server";
import {
  getDocoConnectionsContext,
  importInstallationConnections,
  setBackfillState,
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
    if (!ctx || repos.length === 0) {
      return redirect(`${panel}?github=connected&count=${repos.length}&imported=0`);
    }

    // Import the PRs in the background. Mark "running" before redirecting; the
    // background job flips it to "done". The user lands on the Doco immediately
    // and sees the "importing…" banner until it finishes.
    const startedAt = new Date().toISOString();
    await setBackfillState(doco.id, {
      status: "running",
      started_at: startedAt,
      repos: repos.length,
    });
    waitUntil(
      backfillInstallationRepos({
        docoDir: docoPath(ctx.handle),
        docoId: doco.id,
        ownerSlug: ctx.orgHandle,
        docoSlug: ctx.handle,
        repos,
        installationId,
        createdByUserId: me.id,
      })
        .then((r) =>
          setBackfillState(doco.id, {
            status: "done",
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            repos: r.repos,
            imported: r.created,
          }),
        )
        .catch((err) => {
          console.error("[github setup] background backfill failed:", err);
          return setBackfillState(doco.id, {
            status: "done",
            started_at: startedAt,
            finished_at: new Date().toISOString(),
          });
        }),
    );
    return redirect(`${panel}?github=importing&count=${repos.length}`);
  } catch (err) {
    // Most likely a bad DOCO_GITHUB_APP_* credential (e.g. an unparseable
    // private key). Don't 500 the user — log and bounce back with a message.
    console.error("[github setup] installation connect failed:", err);
    return redirect(`${panel}?github=setup_failed`);
  }
}
