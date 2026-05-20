import { withClient } from "@doco/db";
import { loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadOverviewNodeDetails } from "~/lib/full-graph.server";

const MAX_IDS = 120;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForRead(request, handle);
  const url = new URL(request.url);
  const ids = Array.from(
    new Set(
      (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_IDS);
  const nodes = await withClient((c) => loadOverviewNodeDetails(c, ctx.meta.docoId, ids, handle));
  return Response.json({ ok: true, nodes });
}
