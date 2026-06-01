// GET /api/v1/agent-chat/conversation.json
//
// Returns a single Señor Doco thread's snapshot. With no query
// params, returns the user's most-recent active thread (or 404 when
// they've never chatted). Pass `?id=<conv_id>`
// to scope to a specific thread; 404 if it doesn't exist or belongs
// to another user. `?before=<iso8601>` paginates older messages for
// infinite scroll-up. Signed-out callers get 401.

import { loadSnapshotForPrincipal } from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

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
  const conversationId = url.searchParams.get("id");
  const snapshot = await loadSnapshotForPrincipal(me.id, {
    before,
    conversationId: conversationId || null,
  });
  if (!snapshot) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json(snapshot);
}
