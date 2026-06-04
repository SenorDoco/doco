import { withClient } from "@doco/db";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadEdgeDialogDetail } from "~/lib/edge-detail.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "Missing edge id" }, { status: 400 });
  const edge = await withClient((c) =>
    loadEdgeDialogDetail(
      c,
      { docoId: ctx.meta.docoId, ownerId: ctx.meta.ownerId },
      { handle: ctx.handle, id, principalId: ctx.me?.id ?? null },
    ),
  );
  if (!edge) return Response.json({ error: `Edge not found: ${id}` }, { status: 404 });
  return Response.json({ edge });
}
