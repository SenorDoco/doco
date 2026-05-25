// PATCH /api/v1/agent-chat/conversation/:id.json
//
// Mutate a single Señor Doco thread. Body fields (all optional):
//   { title?: string | null, archived?: boolean }
//
// Used by the sidebar's per-thread context menu — rename inline and
// archive. Returns the updated row. 404 when the id doesn't exist
// or belongs to another user.
//
// DELETE not exposed — archive is the soft-delete; the row stays
// around so the agent can still reference it (transcripts referenced
// by published Doco entries, etc.). Hard delete is admin-only.

import { patchConversation } from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface PatchBody {
  title?: unknown;
  archived?: unknown;
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  if (request.method !== "PATCH") {
    return new Response("method not allowed", { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }
  const id = params.id;
  if (!id) {
    return Response.json({ error: "missing_id" }, { status: 400 });
  }
  let body: PatchBody = {};
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch: { title?: string | null; archived?: boolean } = {};
  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    if (body.title === null) {
      patch.title = null;
    } else if (typeof body.title === "string") {
      patch.title = body.title.trim().slice(0, 120) || null;
    } else {
      return Response.json({ error: "invalid_title" }, { status: 400 });
    }
  }
  if (typeof body.archived === "boolean") {
    patch.archived = body.archived;
  }
  const row = await patchConversation(id, me.id, patch);
  if (!row) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({
    conversation: {
      id: row.id,
      title: row.title,
      archived: row.archived,
      updated_at: row.updated_at.toISOString(),
      active_turn_started_at: row.active_turn_started_at?.toISOString() ?? null,
    },
  });
}
