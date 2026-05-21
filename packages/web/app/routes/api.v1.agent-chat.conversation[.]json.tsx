// GET /api/v1/agent-chat/conversation.json
//
// Returns the signed-in user's active rolling conversation + every
// message ever appended to it. The sidebar calls this on mount to
// hydrate after a page reload or fresh sign-in. Signed-out callers
// get a 401 — the sidebar only renders when there's a session, so
// this should never be hit anonymously in normal flow.

import { loadSnapshotForPrincipal } from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const snapshot = await loadSnapshotForPrincipal(me.id);
  return Response.json(snapshot);
}
