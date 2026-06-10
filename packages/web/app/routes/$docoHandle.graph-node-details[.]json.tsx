import { withClient } from "@doco/db";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadOverviewNodeDetails } from "~/lib/full-graph.server";
import { isGraphNodeType, loadNodeDialogDetail } from "~/lib/node-detail.server";

const MAX_IDS = 120;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { handle } = ctx;
  const url = new URL(request.url);
  const ids = Array.from(
    new Set(
      (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_IDS);
  const selectedId = url.searchParams.get("id")?.trim() ?? "";
  const selectedTypeParam = url.searchParams.get("type")?.trim() ?? "";
  const selectedType =
    selectedTypeParam ||
    (selectedId.includes("_") ? selectedId.slice(0, selectedId.indexOf("_")) : "");

  const { nodes, node } = await withClient(async (c) => {
    const nodes = await loadOverviewNodeDetails(c, ctx.meta.docoId, ids, handle);
    if (!selectedId) return { nodes, node: null };
    if (!isGraphNodeType(selectedType)) {
      throw new Response("Unknown node type", { status: 404 });
    }
    const node = await loadNodeDialogDetail(c, ctx.meta, {
      handle,
      nodeType: selectedType,
      id: selectedId,
      principalId: ctx.me?.id ?? null,
    });
    if (!node) {
      throw new Response(`Node not found: ${selectedId}`, { status: 404 });
    }
    return { nodes, node };
  });
  return Response.json({ ok: true, nodes, node });
}
