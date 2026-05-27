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
    throw redirect(`/integrations?provider=slack&slack_error=${encodeURIComponent(error)}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const config = getSlackConfig();
  if (!code || !state || !config.signingSecret) {
    throw redirect("/integrations?provider=slack&slack_error=missing_oauth_response");
  }

  try {
    const parsedState = verifySlackState(state, config.signingSecret);
    const response = await exchangeSlackOAuthCode(request, code);
    await upsertSlackInstallation({
      response,
      installedByCollaboratorId: parsedState.installerId,
    });
    const teamName = response.team?.name ?? response.team?.id ?? "workspace";
    throw redirect(`/integrations?provider=slack&slack_installed=${encodeURIComponent(teamName)}`);
  } catch (err) {
    if (err instanceof Response) throw err;
    throw redirect("/integrations?provider=slack&slack_error=install_failed");
  }
}
