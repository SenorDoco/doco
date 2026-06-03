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

import { listWorkspacesForUser } from "@doco/db";
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
  workspace_id?: unknown;
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

  // A thread may be scoped to a Workspace at creation. Only allow scoping to a
  // Workspace the caller actually belongs to — otherwise drop the scope rather
  // than leak that the id exists.
  const requestedWorkspaceId =
    typeof body.workspace_id === "string" && body.workspace_id.trim()
      ? body.workspace_id.trim()
      : null;
  let workspaceId: string | null = null;
  let workspaceHandle: string | null = null;
  if (requestedWorkspaceId) {
    const mine = await listWorkspacesForUser(me.id);
    const match = mine.find((w) => w.id === requestedWorkspaceId);
    if (!match) {
      return Response.json({ error: "workspace_not_found" }, { status: 403 });
    }
    workspaceId = match.id;
    workspaceHandle = match.handle;
  }

  const conv = await createConversation(me.id, { title, workspaceId });
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
      workspace_id: conv.workspace_id,
      workspace_handle: workspaceHandle,
    },
  });
}
