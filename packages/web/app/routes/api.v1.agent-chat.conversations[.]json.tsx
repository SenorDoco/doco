// GET  /api/v1/agent-chat/conversations.json
//   List the signed-in user's Señor Doco threads, newest first. The
//   sidebar dropdown calls this on open. Optional `?include_archived=1`
//   surfaces archived threads (used by a future "Archived" section).
//   `?limit=N` caps the page (default 50, max 200).
//
// POST /api/v1/agent-chat/conversations.json
//   Mint a fresh thread. Body: { title?: string }. Returns the new
//   conversation row. Used when the user clicks "New chat" in the
//   sidebar. Server fills in the title from the first user message
//   if none is provided here.
//
// Signed-out callers get 401.

import {
  type ConversationListItem,
  createConversation,
  listConversationsForPrincipal,
} from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("include_archived") === "1";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  const conversations: ConversationListItem[] = await listConversationsForPrincipal(me.id, {
    includeArchived,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return Response.json({ conversations });
}

interface CreateBody {
  title?: unknown;
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  let body: CreateBody = {};
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    // Empty body is fine — title is optional.
  }
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : null;
  const conv = await createConversation(me.id, { title });
  return Response.json({
    conversation: {
      id: conv.id,
      title: conv.title,
      archived: conv.archived,
      message_count: 0,
      updated_at: conv.updated_at.toISOString(),
      active_turn_started_at: conv.active_turn_started_at?.toISOString() ?? null,
      last_message_preview: null,
      last_message_role: null,
      attached_doco_ids: conv.attached_doco_ids ?? [],
      attached_workspace_handles: [],
    },
  });
}
