// GET /<doco-handle>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. Vector-only ranking (ADR-052).
// Resource route — no default export.
import { withClient } from "@doco/db";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { etaggedJson } from "~/lib/etag.server";
import {
  type SearchFilters,
  computeFilterFacets,
  parseSearchFilters,
} from "~/lib/search-filters.server";
import { type SearchHit, rankSearchEmbeddings } from "~/lib/search.server";

interface JsonSearchHit {
  id: string;
  node_type: string;
  name: string | null;
  summary?: string;
  lifecycle: string | null;
  created_at: string | null;
  gpr: number;
  vector_score: number;
  file_path: string | null;
  pinned?: boolean;
}

function toJsonSearchHit(hit: SearchHit): JsonSearchHit {
  return {
    ...hit,
    vector_score: hit.vector_score ?? 0,
    // Search is Postgres-backed now; the legacy file_path field stays
    // present for older clients but no longer points at filesystem state.
    file_path: null,
  };
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const start = performance.now();
  const ctx = await loadDocoRouteForRead(request, params);
  const { handle } = ctx;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  return withClient(async (c) => {
    const facets = await computeFilterFacets(c, ctx.meta.docoId);
    const filters: SearchFilters = parseSearchFilters(url.searchParams, facets);

    const filtersOut = {
      lifecycle: filters.lifecycle,
      node_type: filters.nodeType,
      limit: filters.limit,
    };

    if (!q) {
      return Response.json({
        query: "",
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
      });
    }

    const provider = getDocoEmbeddingProvider();
    if (!provider) {
      return Response.json({
        query: q,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        warning: "Vector search unavailable: no embedding provider configured (OPENAI_API_KEY).",
      });
    }

    let queryEmbedding: Float32Array;
    try {
      const [v] = await provider.embed([q]);
      if (!v || v.length === 0) {
        return Response.json({
          query: q,
          count: 0,
          duration_ms: Math.round(performance.now() - start),
          filters: filtersOut,
          hits: [],
          warning: "Vector search unavailable: provider returned empty embedding.",
        });
      }
      queryEmbedding = v;
    } catch (e) {
      return Response.json({
        query: q,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        warning: `Vector search unavailable: ${(e as Error).message}`,
      });
    }

    const ranked = await rankSearchEmbeddings(
      c,
      ctx.meta.docoId,
      queryEmbedding,
      filters,
      filters.limit,
    );
    if (ranked.hits.length === 0) {
      return Response.json({
        query: q,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        warning:
          ranked.candidateIds === null
            ? "No embeddings in this Doco yet — reindex first."
            : "No entities match the active filters.",
      });
    }
    const allHits = ranked.hits.map(toJsonSearchHit);

    const stableData = {
      query: q,
      count: allHits.length,
      filters: filtersOut,
      hits: allHits,
    };
    return etaggedJson(
      request,
      {
        ...stableData,
        duration_ms: Math.round(performance.now() - start),
      },
      { stableData },
    );
  });
}
