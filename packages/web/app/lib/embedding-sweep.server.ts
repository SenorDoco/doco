// The embedding sweep: a paced pass that gives every entity a current vector.
// Capture embeds a changed node inline; this is the backfill that covers the
// rest: a fresh database, the move to pgvector chunks, a model swap, a batch
// that failed. Nodes with no row for the configured model are embedded from
// their index text, Doco by Doco, in batches, until the deadline. Mirror rows
// (Notion pages, Slack messages) join this pass through their own sources.
import {
  type EmbeddingProviderLike,
  chunkText,
  nodeIndexText,
  upsertEmbeddings,
  withClient,
} from "@doco/db";

export const SWEEP_DEADLINE_MS = 50_000;
const NODES_PER_BATCH = 100;

export interface EmbeddingSweepResult {
  /** Nodes embedded in this pass. */
  nodes: number;
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
  const result: EmbeddingSweepResult = { nodes: 0, batches: 0, exhausted: false };
  for (;;) {
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
        [args.docoId ?? null, args.provider.modelId, NODES_PER_BATCH],
      ),
    );
    if (rows.rows.length === 0) {
      result.exhausted = true;
      return result;
    }
    const inputs = rows.rows.map((row) => ({
      source: "node" as const,
      entity_id: row.id,
      doco_id: row.doco_id,
      chunks: chunkText(nodeIndexText(row.prose, row.extra)),
    }));
    await withClient((c) => upsertEmbeddings(c, inputs, args.provider));
    result.nodes += inputs.length;
    result.batches++;
    if (Date.now() >= deadline) return result;
  }
}
