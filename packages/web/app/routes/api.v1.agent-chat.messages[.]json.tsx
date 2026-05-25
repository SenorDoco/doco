// POST /api/v1/agent-chat/messages.json
//
// Streams an agent reply. Request body:
//   { text: string, current_path?: string, conversation_id?: string }
//
// Response: Server-Sent Events. One JSON event per line, framed
// `data: <json>\n\n`. Event kinds match ChatStreamEvent in
// agent-chat.server.ts — text_delta, tool_use_start, tool_use_input,
// tool_use_result, navigate, message_saved, done, error.
//
// `conversation_id` targets a specific Señor Doco thread; when
// omitted, falls back to the user's active thread (auto-created
// the first time they chat). Mismatched ids return 404.
//
// The client consumes via fetch + ReadableStream (not EventSource —
// EventSource doesn't support POST, and we need to send the user's
// text + current page context in the body).

import {
  type ChatStreamEvent,
  type VisibleGraphReferenceGroup,
  loadConversationByIdForPrincipal,
  loadOrCreateConversation,
  runAssistantTurn,
} from "~/lib/agent-chat.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface Body {
  text?: unknown;
  current_path?: unknown;
  attachment_ids?: unknown;
  graph_references?: unknown;
  conversation_id?: unknown;
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function parseGraphReferences(value: unknown): VisibleGraphReferenceGroup[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((group): VisibleGraphReferenceGroup[] => {
    if (!group || typeof group !== "object") return [];
    const raw = group as { source?: unknown; references?: unknown };
    if (!Array.isArray(raw.references)) return [];
    const references = raw.references.slice(0, 120).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      const number = Number(candidate.number);
      const id = cleanString(candidate.id, 128);
      const entityType = cleanString(candidate.entity_type, 64);
      if (!Number.isInteger(number) || number < 1 || !id || !entityType) return [];
      return [
        {
          number,
          id,
          entity_type: entityType,
          label: cleanString(candidate.label, 220) || id,
          lifecycle: cleanString(candidate.lifecycle, 40) || null,
          href: cleanString(candidate.href, 240) || null,
        },
      ];
    });
    if (references.length === 0) return [];
    return [
      {
        source: cleanString(raw.source, 40) || "graph",
        references,
      },
    ];
  });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  let parsed: Body;
  try {
    parsed = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  const attachmentIds = Array.isArray(parsed.attachment_ids)
    ? (parsed.attachment_ids.filter((v) => typeof v === "string" && v.length > 0) as string[])
    : [];
  if (!text && attachmentIds.length === 0) {
    return Response.json({ error: "text_or_attachments_required" }, { status: 400 });
  }
  const currentPath =
    typeof parsed.current_path === "string" && parsed.current_path.length > 0
      ? parsed.current_path
      : null;
  const graphReferences = parseGraphReferences(parsed.graph_references);
  const conversationId =
    typeof parsed.conversation_id === "string" && parsed.conversation_id.length > 0
      ? parsed.conversation_id
      : null;

  const conversation = conversationId
    ? await loadConversationByIdForPrincipal(conversationId, me.id)
    : await loadOrCreateConversation(me.id);
  if (!conversation) {
    return Response.json({ error: "conversation_not_found" }, { status: 404 });
  }
  const cookieHeader = request.headers.get("cookie") ?? "";
  const origin = new URL(request.url).origin;

  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: ChatStreamEvent) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      try {
        for await (const event of runAssistantTurn({
          conversation,
          userText: text,
          ctx: {
            origin,
            cookieHeader,
            principal: me,
            currentPath,
            attachmentIds,
            graphReferences,
            conversationId: conversation.id,
          },
        })) {
          send(event);
          if (event.kind === "done" || event.kind === "error") break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ kind: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
