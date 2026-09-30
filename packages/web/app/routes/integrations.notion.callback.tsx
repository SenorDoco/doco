// Notion sends the owner back here after the authorization page (and its
// page picker). Nothing in the query string is trusted on its own: the state
// must be one the consent form signed for the signed-in user, the Doco must
// still live in the workspace that user owns, and the code is exchanged for
// the token pair before the mirror is recorded. Then the sync takes over.
import { getDocoById, getWorkspaceRole } from "@doco/db";
import { redirect } from "react-router";
import { exchangeNotionCode, getNotionConfig } from "~/lib/notion-api.server";
import {
  enableNotionMirror,
  notionRedirectUri,
  verifyNotionState,
} from "~/lib/notion-mirror-setup.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const state = verifyNotionState(
    url.searchParams.get("state") ?? "",
    getNotionConfig().clientSecret,
  );
  if (!state) throw redirect("/workspaces?notion=invalid_state");
  const doco = await getDocoById(state.docoId);
  if (!doco || doco.workspace_id !== state.workspaceId) {
    throw redirect("/workspaces?notion=doco_not_found");
  }
  const panel = `/${doco.handle}/integrations/notion`;
  if (url.searchParams.get("error")) throw redirect(`${panel}?notion=denied`);

  const me = await getCurrentPrincipalAsync(request);
  if (!me) throw redirect(`${panel}?notion=signin_required`);
  if (me.id !== state.userId) throw redirect(`${panel}?notion=forbidden`);
  if ((await getWorkspaceRole(doco.workspace_id, me.id)) !== "owner") {
    throw redirect(`${panel}?notion=not_owner`);
  }
  const code = url.searchParams.get("code");
  if (!code) throw redirect(`${panel}?notion=authorization_failed`);

  const tokens = await exchangeNotionCode(code, notionRedirectUri(request)).catch((error) => {
    console.error("[notion] code exchange failed:", (error as Error).message);
    return null;
  });
  if (!tokens) throw redirect(`${panel}?notion=authorization_failed`);
  const result = await enableNotionMirror({ docoId: doco.id, tokens, consentedBy: me.id });
  if (!result.ok) {
    const params = new URLSearchParams({ notion: result.reason, handle: result.handle });
    throw redirect(`${panel}?${params.toString()}`);
  }
  throw redirect(`${panel}?notion=mirroring`);
}
