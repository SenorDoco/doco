// GET /api/v1/agent-chat/conversation.json
//
// Returns the signed-in user's active rolling conversation. By default
// returns the most recent page of messages (newest at the bottom) plus
// a `has_more` flag; pass `?before=<iso8601>` to fetch the page of
// messages strictly older than that timestamp — the sidebar uses this
// for infinite scroll-up. Signed-out callers get a 401 — the sidebar
// only renders when there's a session, so this should never be hit
// anonymously in normal flow.

import { loadSnapshotForPrincipal } from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const url = new URL(request.url);
  const beforeStr = url.searchParams.get("before");
  let before: Date | null = null;
  if (beforeStr) {
    const d = new Date(beforeStr);
    if (!Number.isNaN(d.getTime())) before = d;
  }
  const snapshot = await loadSnapshotForPrincipal(me.id, { before });
  return Response.json(snapshot);
}
