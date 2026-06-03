// PATCH /api/v1/agent-chat/conversation/:id.json
//
// Mutate a single Señor Doco thread. Body fields (all optional):
//   { title?: string | null,
//     archived?: boolean,
//     stop_active_turn?: boolean }
//
// title / archived go through `patchConversation`; either or both may
// run in a single request alongside stop_active_turn — the route
// stitches the results so the response reflects the post-patch row.
//
// DELETE not exposed — archive is the soft-delete; the row stays
// around so the agent can still reference it. Hard delete is
// admin-only.

import { patchConversation, stopActiveTurnForPrincipal } from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface PatchBody {
  title?: unknown;
  archived?: unknown;
  stop_active_turn?: unknown;
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
  if (
    Object.prototype.hasOwnProperty.call(body, "stop_active_turn") &&
    typeof body.stop_active_turn !== "boolean"
  ) {
    return Response.json({ error: "invalid_stop_active_turn" }, { status: 400 });
  }
  const shouldStopActiveTurn = body.stop_active_turn === true;
  const hasPatch = Object.keys(patch).length > 0;
  // Run stop first, then patch (title/archived). Both return the
  // updated row; we take the last non-null and bail with 404 when any
  // scoped mutation says the conversation isn't ours.
  let stoppedActiveTurn = false;
  let row = null;
  if (shouldStopActiveTurn) {
    const stopped = await stopActiveTurnForPrincipal(id, me.id);
    row = stopped.row;
    stoppedActiveTurn = stopped.stopped;
    if (!row) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (hasPatch) {
    row = await patchConversation(id, me.id, patch);
  }
  if (hasPatch && !row) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!row) {
    // Empty patch — load the current row so the client gets fresh state.
    row = await patchConversation(id, me.id, {});
    if (!row) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  return Response.json({
    stopped_active_turn: stoppedActiveTurn,
    conversation: {
      id: row.id,
      title: row.title,
      archived: row.archived,
      updated_at: row.updated_at.toISOString(),
      active_turn_started_at: row.active_turn_started_at?.toISOString() ?? null,
    },
  });
}
