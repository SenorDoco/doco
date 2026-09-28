// The embedding sweep: a paced pass that gives every entity a current vector.
// Capture embeds a changed node inline; this is the backfill that covers the
// rest (a fresh database, the move to pgvector chunks, a model swap, a batch
// that failed) and the only embedding path for mirror rows: Notion pages
// whose content was copied since they were last embedded, and Slack messages
// whose text was. Each pass takes one batch per source in turn, nodes, pages,
// messages, until the deadline, so a large backlog in one source never starves
// the others. Rows of deleted Docos are left alone.
import {
  type EmbeddingInput,
  type EmbeddingProviderLike,
  chunkText,
  nodeIndexText,
  upsertEmbeddings,
  withClient,
} from "@doco/db";
import { notionPageChunks } from "./notion-chunks";
import { slackMessageText } from "./slack-mirror-read.server";

export const SWEEP_DEADLINE_MS = 50_000;
const NODES_PER_BATCH = 100;
const PAGES_PER_BATCH = 50;
const MESSAGES_PER_BATCH = 200;

export interface EmbeddingSweepResult {
  nodes: number;
  pages: number;
  messages: number;
  batches: number;
  /** True when nothing was left to embed when the pass ended. */
  exhausted: boolean;
}

export async function sweepEmbeddings(args: {
  provider: EmbeddingProviderLike;
  /** One Doco only; every live Doco when omitted. */
  docoId?: string;
  deadlineMs?: number;
}): Promise<EmbeddingSweepResult> {
  const deadline = Date.now() + (args.deadlineMs ?? SWEEP_DEADLINE_MS);
  const scope = args.docoId ?? null;
  const result: EmbeddingSweepResult = {
    nodes: 0,
    pages: 0,
    messages: 0,
    batches: 0,
    exhausted: false,
  };
  const sources = [
    ["nodes", () => embedNodes(args.provider, scope)],
    ["pages", () => embedNotionPages(args.provider, scope)],
    ["messages", () => embedSlackMessages(args.provider, scope)],
  ] as const;
  for (;;) {
    let progressed = false;
    for (const [counter, source] of sources) {
      const done = await source();
      if (done > 0) {
        result[counter] += done;
        result.batches++;
        progressed = true;
      }
      if (Date.now() >= deadline) return result;
    }
    if (!progressed) {
      result.exhausted = true;
      return result;
    }
  }
}

/** Nodes with no row for this model, from their index text. */
async function embedNodes(provider: EmbeddingProviderLike, scope: string | null): Promise<number> {
  const rows = await withClient((c) =>
    c.query<{
      id: string;
      doco_id: string;
      prose: string | null;
      extra: Record<string, unknown> | null;
    }>(
      `SELECT n.id, n.doco_id, n.prose, n.extra
         FROM nodes n
         JOIN docos d ON d.id = n.doco_id AND d.deleted_at IS NULL
        WHERE ($1::text IS NULL OR n.doco_id = $1)
          AND btrim(coalesce(n.prose, '')) <> ''
          AND NOT EXISTS (SELECT 1 FROM embeddings e
                           WHERE e.doco_id = n.doco_id AND e.entity_id = n.id
                             AND e.model_id = $2)
        ORDER BY n.doco_id, n.id
        LIMIT $3`,
      [scope, provider.modelId, NODES_PER_BATCH],
    ),
  );
  if (rows.rows.length === 0) return 0;
  const inputs: EmbeddingInput[] = rows.rows.map((row) => ({
    source: "node",
    entity_id: row.id,
    doco_id: row.doco_id,
    chunks: chunkText(nodeIndexText(row.prose, row.extra)),
  }));
  await withClient((c) => upsertEmbeddings(c, inputs, provider));
  return inputs.length;
}

/** Notion pages whose copied content changed since their chunks were embedded. */
async function embedNotionPages(
  provider: EmbeddingProviderLike,
  scope: string | null,
): Promise<number> {
  const rows = await withClient((c) =>
    c.query<{
      doco_id: string;
      page_id: string;
      title: string;
      markdown: string;
      content_hash: string;
    }>(
      `SELECT p.doco_id, p.page_id, p.title, p.markdown, p.content_hash
         FROM notion_pages p
         JOIN docos d ON d.id = p.doco_id AND d.deleted_at IS NULL
        WHERE ($1::text IS NULL OR p.doco_id = $1)
          AND p.synced_at IS NOT NULL
          AND p.embedded_hash IS DISTINCT FROM p.content_hash
        ORDER BY p.doco_id, p.page_id
        LIMIT $2`,
      [scope, PAGES_PER_BATCH],
    ),
  );
  if (rows.rows.length === 0) return 0;
  const inputs: EmbeddingInput[] = rows.rows.map((row) => ({
    source: "notion",
    entity_id: row.page_id,
    doco_id: row.doco_id,
    chunks: notionPageChunks(row.title, row.markdown),
  }));
  await withClient(async (c) => {
    await upsertEmbeddings(c, inputs, provider);
    await c.query(
      `UPDATE notion_pages p SET embedded_hash = t.hash
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(doco_id, page_id, hash)
        WHERE p.doco_id = t.doco_id AND p.page_id = t.page_id`,
      [
        rows.rows.map((r) => r.doco_id),
        rows.rows.map((r) => r.page_id),
        rows.rows.map((r) => r.content_hash),
      ],
    );
  });
  return inputs.length;
}

/** Slack messages whose text changed since their chunk was embedded, newest
 *  first so a fresh mirror's recent conversation is searchable soonest. */
async function embedSlackMessages(
  provider: EmbeddingProviderLike,
  scope: string | null,
): Promise<number> {
  const rows = await withClient((c) =>
    c.query<{
      doco_id: string;
      channel_id: string;
      ts: string;
      text: string;
      hash: string;
      channel_name: string;
      author: string;
    }>(
      `SELECT m.doco_id, m.channel_id, m.ts, m.text, md5(m.text) AS hash, ch.name AS channel_name,
              coalesce(nullif(mem.display_name, ''), nullif(mem.real_name, ''), m.author_id, '')
                AS author
         FROM group_chat_messages m
         JOIN docos d ON d.id = m.doco_id AND d.deleted_at IS NULL
         JOIN group_chat_channels ch
           ON ch.doco_id = m.doco_id AND ch.channel_id = m.channel_id AND NOT ch.excluded
         LEFT JOIN group_chat_members mem
           ON mem.doco_id = m.doco_id AND mem.chat_user_id = m.author_id
        WHERE ($1::text IS NULL OR m.doco_id = $1)
          AND m.embedded_hash IS DISTINCT FROM md5(m.text)
        ORDER BY m.doco_id, m.posted_at DESC
        LIMIT $2`,
      [scope, MESSAGES_PER_BATCH],
    ),
  );
  if (rows.rows.length === 0) return 0;
  const docoIds = [...new Set(rows.rows.map((r) => r.doco_id))];
  const members = await withClient((c) =>
    c.query<{ doco_id: string; chat_user_id: string; display_name: string; real_name: string }>(
      `SELECT doco_id, chat_user_id, display_name, real_name
         FROM group_chat_members WHERE doco_id = ANY($1::text[])`,
      [docoIds],
    ),
  );
  const names = new Map<string, Map<string, string>>();
  for (const m of members.rows) {
    const byId = names.get(m.doco_id) ?? new Map<string, string>();
    byId.set(m.chat_user_id, m.display_name || m.real_name || m.chat_user_id);
    names.set(m.doco_id, byId);
  }
  const inputs: EmbeddingInput[] = rows.rows.map((row) => ({
    source: "slack",
    entity_id: `${row.channel_id}:${row.ts}`,
    doco_id: row.doco_id,
    chunks: chunkText(
      slackMessageText(row.channel_name, row.author, row.text, names.get(row.doco_id) ?? new Map()),
    ),
  }));
  await withClient(async (c) => {
    await upsertEmbeddings(c, inputs, provider);
    await c.query(
      `UPDATE group_chat_messages m SET embedded_hash = t.hash
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(doco_id, channel_id, ts, hash)
        WHERE m.doco_id = t.doco_id AND m.channel_id = t.channel_id AND m.ts = t.ts`,
      [
        rows.rows.map((r) => r.doco_id),
        rows.rows.map((r) => r.channel_id),
        rows.rows.map((r) => r.ts),
        rows.rows.map((r) => r.hash),
      ],
    );
  });
  return inputs.length;
}
