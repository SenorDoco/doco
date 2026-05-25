// PATCH /api/v1/agent-chat/conversation/:id.json
//
// Mutate a single Señor Doco thread. Body fields (all optional):
//   { title?: string | null,
//     archived?: boolean,
//     attach_doco?: string,
//     detach_doco?: string,
//     attach_org?: string,
//     detach_org?: string }
//
// title / archived go through `patchConversation`; attach/detach go
// through `mutateConversationAttachments`. Either or both may run in
// a single request — the route stitches the results so the response
// always reflects the post-patch row.
//
// DELETE not exposed — archive is the soft-delete; the row stays
// around so the agent can still reference it. Hard delete is
// admin-only.

import {
  mutateConversationAttachments,
  patchConversation,
} from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface PatchBody {
  title?: unknown;
  archived?: unknown;
  attach_doco?: unknown;
  detach_doco?: unknown;
  attach_org?: unknown;
  detach_org?: unknown;
}

function cleanHandle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 128);
  return trimmed || undefined;
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
  const ops = {
    attachDoco: cleanHandle(body.attach_doco),
    detachDoco: cleanHandle(body.detach_doco),
    attachOrg: cleanHandle(body.attach_org),
    detachOrg: cleanHandle(body.detach_org),
  };
  const hasAttachmentOp =
    ops.attachDoco || ops.detachDoco || ops.attachOrg || ops.detachOrg;
  const hasPatch = Object.keys(patch).length > 0;
  // Run patch first (title/archived), then attachments. Both return
  // the updated row; we take the last non-null and bail with 404
  // when either says the conversation isn't ours.
  let row = hasPatch ? await patchConversation(id, me.id, patch) : null;
  if (hasPatch && !row) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (hasAttachmentOp) {
    row = await mutateConversationAttachments(id, me.id, ops);
    if (!row) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (!row) {
    // Empty patch — load the current row so the client gets fresh state.
    row = await patchConversation(id, me.id, {});
    if (!row) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  return Response.json({
    conversation: {
      id: row.id,
      title: row.title,
      archived: row.archived,
      updated_at: row.updated_at.toISOString(),
      active_turn_started_at: row.active_turn_started_at?.toISOString() ?? null,
      attached_doco_handles: row.attached_doco_handles ?? [],
      attached_org_handles: row.attached_org_handles ?? [],
    },
  });
}
