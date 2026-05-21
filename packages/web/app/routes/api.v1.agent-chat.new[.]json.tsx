// POST /api/v1/agent-chat/new.json
//
// Archives the user's current rolling conversation and returns the
// fresh empty one. Used by the sidebar's "New chat" button.

import {
  archiveConversation,
  loadOrCreateActiveConversation,
  loadSnapshotForPrincipal,
} from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const current = await loadOrCreateActiveConversation(me.id);
  await archiveConversation(current.id, me.id);
  const snapshot = await loadSnapshotForPrincipal(me.id);
  return Response.json(snapshot);
}
