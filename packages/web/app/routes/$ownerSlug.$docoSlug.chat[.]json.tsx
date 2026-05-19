// POST /:docoId/chat.json
//
// Doco-wide chat endpoint for Señor Doco. The browser keeps the chat mounted
// in the root shell while this endpoint receives the current URL as context,
// applies tool calls through Doco's capture/update helpers, and returns an
// optional `navigate_to` URL for the page on the right.

import { docoPath } from "~/lib/db.server";
import { loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { type ChatAttachment, type ChatTurn, runDocoChatTurn } from "~/lib/doco-chat.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { isHumanPrincipal } from "~/lib/session";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }

  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForRead(request, handle);
  if (!ctx.me) {
    return Response.json({ error: "Sign in to use Señor Doco." }, { status: 401 });
  }
  if (!isHumanPrincipal(ctx.me)) {
    return Response.json(
      { error: "Señor Doco is available to signed-in human users." },
      { status: 403 },
    );
  }

  let body: { message?: unknown; history?: unknown; attachments?: unknown; currentPath?: unknown };
  try {
    body = (await request.json()) as {
      message?: unknown;
      history?: unknown;
      attachments?: unknown;
      currentPath?: unknown;
    };
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const attachmentsResult = sanitizeAttachments(body.attachments);
  if ("error" in attachmentsResult) {
    return Response.json({ error: attachmentsResult.error }, { status: 400 });
  }
  const attachments = attachmentsResult.attachments;
  if (!message && attachments.length === 0) {
    return Response.json({ error: "Empty message." }, { status: 400 });
  }

  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) return Response.json({ error: `Doco "${handle}" not found.` }, { status: 404 });

  const result = await runDocoChatTurn({
    docoDir: dir,
    docoId: ctx.meta.docoId,
    ownerSlug,
    docoSlug,
    handle,
    meta,
    message,
    history: sanitizeHistory(body.history),
    attachments,
    currentPath: typeof body.currentPath === "string" ? body.currentPath : "",
    docoHost: new URL(request.url).origin,
    actor: ctx.me,
  });

  return Response.json(result, { status: 200 });
}

export function loader() {
  return Response.json({ error: "Use POST." }, { status: 405 });
}

function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ChatTurn | null => {
      if (!entry || typeof entry !== "object") return null;
      const rec = entry as Record<string, unknown>;
      const role = rec.role;
      const content = rec.content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
      return { role, content };
    })
    .filter((t): t is ChatTurn => t !== null)
    .slice(-20);
}

function sanitizeAttachments(raw: unknown): { attachments: ChatAttachment[] } | { error: string } {
  if (raw === undefined || raw === null) return { attachments: [] };
  if (!Array.isArray(raw)) return { error: "attachments must be an array." };
  const out: ChatAttachment[] = [];
  let total = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.slice(0, 200) : "";
    const mime = typeof rec.mime === "string" ? rec.mime.toLowerCase() : "";
    const size = typeof rec.size === "number" && Number.isFinite(rec.size) ? rec.size : 0;
    const dataUrl = typeof rec.dataUrl === "string" ? rec.dataUrl : "";
    if (!name || !dataUrl.startsWith("data:")) continue;
    total += dataUrl.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      return {
        error: `Attachments exceed the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB total cap.`,
      };
    }
    out.push({ name, mime, size, dataUrl });
  }
  return { attachments: out };
}
