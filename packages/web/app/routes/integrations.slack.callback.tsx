import { redirect } from "react-router";
import {
  exchangeSlackOAuthCode,
  getSlackConfig,
  upsertSlackInstallation,
  verifySlackState,
} from "~/lib/slack.server";

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
    const response = await exchangeSlackOAuthCode(request, code);
    await upsertSlackInstallation({
      response,
      installedByUserId: parsedState.installerId,
    });
    const teamId = response.team?.id;
    if (!teamId) throw new Error("Slack OAuth response did not include a team id.");
    const params = new URLSearchParams({ team_id: teamId });
    throw redirect(`/integrations/slack/setup?${params.toString()}`);
  } catch (err) {
    if (err instanceof Response) throw err;
    throw redirect("/integrations?slack_error=install_failed");
  }
}
