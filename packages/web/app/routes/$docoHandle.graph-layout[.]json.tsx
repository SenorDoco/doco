import { withClient } from "@doco/db";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  INDEXED_PERSPECTIVE_KINDS,
  queryPerspectiveLayoutViewport,
} from "~/lib/perspective-layout.server";

const DEFAULT_MIN = -1000;
const DEFAULT_MAX = 1000;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const value = Math.floor(numberParam(url, name, fallback));
  return Math.min(Math.max(value, min), max);
}

function parsePerspective(url: URL): string {
  const perspective = url.searchParams.get("perspective")?.trim() || "graph";
  return INDEXED_PERSPECTIVE_KINDS.includes(
    perspective as (typeof INDEXED_PERSPECTIVE_KINDS)[number],
  )
    ? perspective
    : "graph";
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const url = new URL(request.url);
  const minX = numberParam(url, "min_x", DEFAULT_MIN);
  const minY = numberParam(url, "min_y", DEFAULT_MIN);
  const maxX = numberParam(url, "max_x", DEFAULT_MAX);
  const maxY = numberParam(url, "max_y", DEFAULT_MAX);
  const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  const lodLevel = intParam(url, "lod", 0, 0, 10);
  const perspectiveKind = parsePerspective(url);

  const result = await withClient((c) =>
    queryPerspectiveLayoutViewport(c, {
      docoId: ctx.meta.docoId,
      perspectiveKind,
      minX: Math.min(minX, maxX),
      minY: Math.min(minY, maxY),
      maxX: Math.max(minX, maxX),
      maxY: Math.max(minY, maxY),
      lodLevel,
      limit,
    }),
  );

  return Response.json(
    {
      ok: true,
      perspective: perspectiveKind,
      viewport: {
        min_x: Math.min(minX, maxX),
        min_y: Math.min(minY, maxY),
        max_x: Math.max(minX, maxX),
        max_y: Math.max(minY, maxY),
        lod: lodLevel,
        limit,
      },
      snapshot: result.snapshot,
      nodes: result.nodes,
      edges: result.edges,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
