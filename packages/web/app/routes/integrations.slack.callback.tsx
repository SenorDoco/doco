import { getWorkspaceRole } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { redirect } from "react-router";
import { startSlackMirror, turnOnSlackMirror } from "~/lib/slack-mirror-setup.server";
import {
  exchangeSlackOAuthCode,
  getSlackConfig,
  upsertSlackInstallation,
  verifySlackState,
} from "~/lib/slack.server";

// Turning on the public-channel mirror kicks off its first channel sync in the
// background (joining every public channel can take a few minutes).
export const config = { maxDuration: 300 };

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    throw redirect(`/integrations?slack_error=${encodeURIComponent(error)}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const config = getSlackConfig();
  if (!code || !state || !config.signingSecret) {
    throw redirect("/integrations?slack_error=missing_oauth_response");
  }

  try {
    const parsedState = verifySlackState(state, config.signingSecret);
    // Re-check ownership at completion — the signed state carried the chosen
    // workspace, but the installer's role could have changed since.
    const role = await getWorkspaceRole(parsedState.docoWorkspaceId, parsedState.installerId);
    if (role !== "owner") {
      throw redirect("/integrations?slack_error=not_workspace_owner");
    }
    const response = await exchangeSlackOAuthCode(request, code);
    await upsertSlackInstallation({
      response,
      installedByUserId: parsedState.installerId,
      docoWorkspaceId: parsedState.docoWorkspaceId,
    });
    const teamId = response.team?.id;
    if (!teamId) throw new Error("Slack OAuth response did not include a team id.");

    if (parsedState.mirrorDocoId) {
      const token = response.access_token ?? "";
      const result = await turnOnSlackMirror({
        docoId: parsedState.mirrorDocoId,
        docoWorkspaceId: parsedState.docoWorkspaceId,
        installerId: parsedState.installerId,
        teamId,
        authedChatUserId: response.authed_user?.id ?? "",
        token,
      });
      if (!result.ok) {
        throw redirect(
          result.reason === "not_slack_admin"
            ? `/${result.handle}/integrations/slack?slack=not_slack_admin`
            : "/integrations?slack_error=mirror_doco_not_found",
        );
      }
      waitUntil(
        startSlackMirror({ docoId: parsedState.mirrorDocoId, token }).catch((err) => {
          console.error(
            "[slack mirror] first sync failed:",
            err instanceof Error ? err.message : err,
          );
        }),
      );
      throw redirect(`/${result.handle}/integrations/slack?slack=mirroring`);
    }

    const params = new URLSearchParams({ team_id: teamId });
    throw redirect(`/integrations/slack/setup?${params.toString()}`);
  } catch (err) {
    if (err instanceof Response) throw err;
    throw redirect("/integrations?slack_error=install_failed");
  }
}
