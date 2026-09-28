// GET|POST /api/embeddings/sweep — Vercel Cron, every minute. One paced pass
// of the embedding sweep (lib/embedding-sweep.server.ts): entities without a
// vector for the configured model get one, in batches, within the deadline.
// A no-op without an embedding provider.
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { sweepEmbeddings } from "~/lib/embedding-sweep.server";

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
  const provider = getDocoEmbeddingProvider();
  if (!provider) return Response.json({ ok: true, skipped: "no_provider" }, { headers });
  const result = await sweepEmbeddings({ provider });
  return Response.json({ ok: true, ...result }, { headers });
}
