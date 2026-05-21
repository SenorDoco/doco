// GET /api/v1/agent-chat/attachments/$attachmentId
//
// Streams an attachment's bytes back to the signed-in owner so the
// sidebar can render an inline image preview (or download a PDF /
// text file). Rows older than 30 days have been purged; those 404.
// Other principals also 404 — the row is scoped to its uploader.

import { loadAttachmentForPrincipal } from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { attachmentId?: string };
}) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return new Response("not signed in", { status: 401 });
  }
  const id = params.attachmentId;
  if (!id) return new Response("missing id", { status: 400 });
  const row = await loadAttachmentForPrincipal(id, me.id);
  if (!row) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(row.content), {
    status: 200,
    headers: {
      "Content-Type": row.mime_type,
      "Content-Length": String(row.size_bytes),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "Cache-Control": "private, max-age=600",
    },
  });
}
