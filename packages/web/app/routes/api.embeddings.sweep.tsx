// GET|POST /api/embeddings/sweep — Vercel Cron, every minute. First the
// PageRank of the Docos whose edges changed (lib/node-ranks.server.ts), then
// one paced pass of the embedding sweep (lib/embedding-sweep.server.ts):
// entities without a vector for the configured model get one, in batches,
// within the deadline; that pass is skipped without an embedding provider.
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
import { withClient } from "@doco/db";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { sweepEmbeddings } from "~/lib/embedding-sweep.server";
import { refreshNodeRanks } from "~/lib/node-ranks.server";

/** The rank refresh's share of the minute; the embedding sweep has 50 s. */
const RANKS_DEADLINE_MS = 5_000;

export const config = { maxDuration: 60 };

export async function loader({ request }: { request: Request }) {
  return run(request);
}

export async function action({ request }: { request: Request }) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const headers = { "Cache-Control": "no-store" };
  const ranks = await withClient((c) => refreshNodeRanks(c, { deadlineMs: RANKS_DEADLINE_MS }));
  const provider = getDocoEmbeddingProvider();
  if (!provider) return Response.json({ ok: true, ranks, skipped: "no_provider" }, { headers });
  const result = await sweepEmbeddings({ provider });
  return Response.json({ ok: true, ranks, ...result }, { headers });
}
