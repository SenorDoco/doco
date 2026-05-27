import { redirect } from "react-router";
import { getCurrentPrincipal } from "~/lib/session.server";
import { buildSlackInstallUrl } from "~/lib/slack.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }

  const installUrl = buildSlackInstallUrl(request, me.id);
  if (!installUrl) {
    throw redirect("/integrations?slack_unavailable=1");
  }
  throw redirect(installUrl);
}
