// POST /:ownerSlug/:docoSlug/:type/:id/chat.json
//
// Per-node chat backend. Receives a user message + prior turns from the
// AiChatPane on the node detail view, calls OpenAI with tool use, applies
// the chosen tool against the existing capture helpers, and returns the
// assistant's reply plus a list of operations that fired.

import { withClient } from "@doco/db";
import { parse as parseYaml } from "yaml";
import type { NodeTypeName } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { type ChatTurn, type NodeContextSnapshot, runChatTurn } from "~/lib/node-chat.server";

const CHAT_SUPPORTED_TYPES = new Set<NodeTypeName>([
  "decision",
  "intent",
  "rule",
  "action",
  "log",
  "reference",
]);

const PLURAL_DIR: Record<NodeTypeName, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  log: "logs",
  reference: "references",
  scope: "scopes",
};

const TABLE_BY_TYPE: Record<NodeTypeName, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  log: "logs",
  reference: "reference_entities",
  scope: "scopes",
};

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; type: string; id: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }

  const { type, id } = params;
  if (!CHAT_SUPPORTED_TYPES.has(type as NodeTypeName)) {
    return Response.json({ error: `Chat is not enabled for ${type} nodes.` }, { status: 422 });
  }
  const nodeType = type as NodeTypeName;

  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForAdmin(request, handle);
  const dir = docoPath(handle);

  let body: { message?: unknown; history?: unknown };
  try {
    body = (await request.json()) as { message?: unknown; history?: unknown };
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json({ error: "Empty message." }, { status: 400 });
  }
  const history = sanitizeHistory(body.history);

  const snapshot = await withClient(async (c) => {
    const table = TABLE_BY_TYPE[nodeType];
    const row = (
      await c.query<{ raw_yaml: string; body_md: string | null }>(
        `SELECT raw_yaml, ${table === "reference_entities" ? "NULL::text" : "body_md"} AS body_md
           FROM ${table}
          WHERE id = $1 AND doco_id = $2`,
        [id, ctx.meta.docoId],
      )
    ).rows[0];
    if (!row) return null;
    const fm = (parseYaml(row.raw_yaml) ?? {}) as Record<string, unknown>;

    const scopeIds = Array.isArray(fm.scopes) ? (fm.scopes as string[]) : [];
    const scopeNames: string[] = [];
    if (scopeIds.length > 0) {
      const r = await c.query<{ name: string }>(
        "SELECT name FROM scopes WHERE doco_id = $1 AND id = ANY($2::text[]) ORDER BY name",
        [ctx.meta.docoId, scopeIds],
      );
      scopeNames.push(...r.rows.map((row) => row.name));
    }
    const available = await c.query<{ name: string }>(
      "SELECT name FROM scopes WHERE doco_id = $1 ORDER BY name",
      [ctx.meta.docoId],
    );

    const snap: NodeContextSnapshot = {
      summary: typeof fm.summary === "string" ? (fm.summary as string) : null,
      body_md: row.body_md,
      lifecycle: typeof fm.lifecycle === "string" ? (fm.lifecycle as string) : null,
      scope_names: scopeNames,
      available_scope_names: available.rows.map((row) => row.name),
    };
    return snap;
  });

  if (!snapshot) {
    return Response.json({ error: `Not found: ${id}` }, { status: 404 });
  }

  const docoHost = new URL(request.url).origin;
  const result = await runChatTurn({
    docoDir: dir,
    docoId: ctx.meta.docoId,
    ownerSlug,
    docoSlug,
    nodeType,
    pluralDir: PLURAL_DIR[nodeType],
    id,
    context: snapshot,
    message,
    history,
    docoHost,
    actorId: ctx.me?.id ?? null,
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
    .slice(-12);
}
