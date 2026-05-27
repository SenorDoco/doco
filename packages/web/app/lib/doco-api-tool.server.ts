import type { Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";

export const DOCO_API_TOOL: Tool = {
  name: "doco_api",
  description:
    "Make an HTTP request to Doco. Returns the response body (JSON parsed when possible, otherwise text), plus the HTTP status.",
  input_schema: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PATCH", "DELETE"],
        description: "HTTP method.",
      },
      path: {
        type: "string",
        description:
          "Relative path starting with /. E.g. '/myhandle/api/decisions.json' or '/api/v1/docos.json'.",
      },
      body: {
        description:
          "JSON body. Required for POST/PATCH on capture endpoints; omit for GET. Pass an object - the tool stringifies it. Principal references must use principal-id fields such as wanted_by_principal_id, actors_principal_ids, actor_principal_id, decided_by_principal_id, authored_by_principal_id, and created_by_principal_id; do not send principal names.",
      },
    },
    required: ["method", "path"],
  },
};

export const DOCO_API_TOOL_RESULT_MAX_BYTES = 8 * 1024;

const ALLOWED_DOCO_API_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

export interface DocoApiToolRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface DocoApiToolEnvelope {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface DocoApiToolResult {
  result: ToolResultBlockParam;
  preview: string;
  ok: boolean;
}

export async function runDocoApiToolRequest(args: {
  toolUseId: string;
  input: unknown;
  execute: (request: DocoApiToolRequest) => Promise<DocoApiToolEnvelope>;
  maxResultBytes?: number;
}): Promise<DocoApiToolResult> {
  const input = args.input as { method?: unknown; path?: unknown; body?: unknown };
  const method = typeof input?.method === "string" ? input.method.toUpperCase() : "GET";
  const path = typeof input?.path === "string" ? input.path : "";
  if (!ALLOWED_DOCO_API_METHODS.has(method)) {
    return docoApiToolError({
      toolUseId: args.toolUseId,
      content: `error: method must be GET, POST, PATCH, or DELETE (got: ${JSON.stringify(method)})`,
      preview: `${method} ${path} - refused (unsupported method)`,
    });
  }
  if (!path.startsWith("/")) {
    return docoApiToolError({
      toolUseId: args.toolUseId,
      content: `error: path must start with "/" (got: ${JSON.stringify(path)})`,
      preview: `${method} ${path} - refused (path must start with /)`,
    });
  }
  try {
    const envelope = await args.execute({ method, path, body: input?.body });
    const previewBody = truncateDocoApiToolPreview(envelope.body, 100);
    return {
      result: {
        type: "tool_result",
        tool_use_id: args.toolUseId,
        content: truncateDocoApiToolResultEnvelope(
          envelope,
          args.maxResultBytes ?? DOCO_API_TOOL_RESULT_MAX_BYTES,
        ),
        is_error: !envelope.ok,
      },
      preview: `${method} ${path} -> ${envelope.status} ${previewBody}`,
      ok: envelope.ok,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return docoApiToolError({
      toolUseId: args.toolUseId,
      content: `fetch failed: ${msg}`,
      preview: `${method} ${path} - fetch failed: ${msg}`,
    });
  }
}

export function truncateDocoApiToolResultEnvelope(
  envelope: DocoApiToolEnvelope,
  maxBytes: number,
): string {
  const full = JSON.stringify(envelope);
  if (full.length <= maxBytes) return full;

  const body = envelope.body as { items?: unknown[]; count?: number } | null;
  if (body && Array.isArray(body.items)) {
    const original = body.items.length;
    let kept = original;
    while (kept > 0) {
      const trimmed = {
        ...envelope,
        body: {
          ...body,
          items: body.items.slice(0, kept),
          truncated: {
            kept_items: kept,
            total_items: original,
            note: "Output capped - fetch /api/<type>/<id>.json for any item's detail.",
          },
        },
      };
      const s = JSON.stringify(trimmed);
      if (s.length <= maxBytes) return s;
      kept = Math.floor(kept / 2);
    }
  }

  const marker = `...[truncated ${full.length - maxBytes} bytes; fetch a specific id for detail]`;
  return `${full.slice(0, maxBytes)}${marker}`;
}

export function truncateDocoApiToolPreview(value: unknown, maxChars: number): string {
  const full = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}...`;
}

function docoApiToolError(args: {
  toolUseId: string;
  content: string;
  preview: string;
}): DocoApiToolResult {
  return {
    result: {
      type: "tool_result",
      tool_use_id: args.toolUseId,
      content: args.content,
      is_error: true,
    },
    preview: args.preview,
    ok: false,
  };
}
