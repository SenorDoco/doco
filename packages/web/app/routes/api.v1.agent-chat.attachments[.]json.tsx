// POST /api/v1/agent-chat/attachments.json
//
// Multipart upload. The sidebar composer stages files locally, posts
// them here as a FormData with one or more `file` parts, and on
// success threads the returned attachment ids into the next call to
// /api/v1/agent-chat/messages.json under `attachment_ids`.
//
// Retention: every stored row carries a 30-day `expires_at`. A
// purge-on-write pass deletes anything past expiry at the top of
// every upload — no separate cron needed for the alpha-cutover scale
// this runs at.
//
// Auth: signed-in only; the row is keyed to the caller's rolling
// conversation, so a second user can't fetch back the bytes.

import {
  ATTACHMENT_ALLOWED_MIME,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_RETENTION_DAYS,
  ATTACHMENT_RETENTION_NOTICE,
  loadOrCreateConversation,
  normalizeUploadMime,
  saveAttachment,
} from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return Response.json(
      { error: "invalid_form_data", message: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const files = form.getAll("file").filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "no_files" }, { status: 400 });
  }

  const conv = await loadOrCreateConversation(me.id);
  const accepted: unknown[] = [];
  const rejected: Array<{ filename: string; reason: string }> = [];

  for (const f of files) {
    // Normalize before the allowlist check so the .bpmn / .xml
    // extension fallback (browsers often send application/octet-stream
    // for those) gets a chance to land. Same call saveAttachment
    // makes — keeping the two consistent so the route-level gate
    // can't reject something the storage layer would have accepted.
    const mime = normalizeUploadMime(f.name, f.type || "application/octet-stream");
    if (!ATTACHMENT_ALLOWED_MIME.has(mime)) {
      rejected.push({ filename: f.name, reason: `unsupported mime type ${mime}` });
      continue;
    }
    if (f.size > ATTACHMENT_MAX_BYTES) {
      rejected.push({
        filename: f.name,
        reason: `too large (${f.size} bytes; max ${ATTACHMENT_MAX_BYTES})`,
      });
      continue;
    }
    const buf = Buffer.from(await f.arrayBuffer());
    try {
      const meta = await saveAttachment({
        conversationId: conv.id,
        principalId: me.id,
        filename: f.name,
        mimeType: mime,
        bytes: buf,
      });
      accepted.push(meta);
    } catch (err) {
      rejected.push({
        filename: f.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    accepted,
    rejected,
    retention_days: ATTACHMENT_RETENTION_DAYS,
    retention_notice: ATTACHMENT_RETENTION_NOTICE,
  });
}
