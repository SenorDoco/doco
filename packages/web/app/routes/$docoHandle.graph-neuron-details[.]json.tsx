import { withClient } from "@doco/db";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadOverviewNodeDetails } from "~/lib/full-graph.server";
import { isGraphNeuronType, loadNeuronDialogDetail } from "~/lib/neuron-detail.server";

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

  const { nodes, neuron } = await withClient(async (c) => {
    const nodes = await loadOverviewNodeDetails(c, ctx.meta.docoId, ids, handle);
    if (!selectedId) return { nodes, neuron: null };
    if (!isGraphNeuronType(selectedType)) {
      throw new Response("Unknown neuron type", { status: 404 });
    }
    const neuron = await loadNeuronDialogDetail(c, ctx.meta, {
      handle,
      entityType: selectedType,
      id: selectedId,
      principalId: ctx.me?.id ?? null,
    });
    if (!neuron) {
      throw new Response(`Neuron not found: ${selectedId}`, { status: 404 });
    }
    return { nodes, neuron };
  });
  return Response.json({ ok: true, nodes, neuron });
}
