// GET /<doco-handle>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. Vector-only ranking (ADR-052).
// Resource route — no default export.
import { withClient } from "@doco/db";
import { loadAgentDisplayIdentity } from "~/lib/agent-identity.server";
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
  entity_type: string;
  name: string | null;
  summary?: string;
  lifecycle: string | null;
  created_at: string | null;
  gpr: number;
  vector_score: number;
  pinned?: boolean;
}

function toJsonSearchHit(hit: SearchHit): JsonSearchHit {
  return {
    ...hit,
    vector_score: hit.vector_score ?? 0,
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
  const goal = ctx.meta.goal;
  // Identity of the caller, so MCP clients can render the right
  // credential-aware Doco indicator without a separate whoami round-trip.
  const viewer = ctx.me ? await loadAgentDisplayIdentity(request) : null;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  return withClient(async (c) => {
    const facets = await computeFilterFacets(c, ctx.meta.docoId);
    const filters: SearchFilters = parseSearchFilters(url.searchParams, facets);

    const filtersOut = {
      lifecycle: filters.lifecycle,
      entity_type: filters.entityType,
      limit: filters.limit,
    };

    if (!q) {
      return Response.json({
        query: "",
        doco_goal: goal,
        viewer,
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
        doco_goal: goal,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        viewer,
        warning: "Vector search unavailable: no embedding provider configured (OPENAI_API_KEY).",
      });
    }

    let queryEmbedding: Float32Array;
    try {
      const [v] = await provider.embed([q], "query");
      if (!v || v.length === 0) {
        return Response.json({
          query: q,
          doco_goal: goal,
          count: 0,
          duration_ms: Math.round(performance.now() - start),
          filters: filtersOut,
          hits: [],
          viewer,
          warning: "Vector search unavailable: provider returned empty embedding.",
        });
      }
      queryEmbedding = v;
    } catch (e) {
      return Response.json({
        query: q,
        doco_goal: goal,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        viewer,
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
        doco_goal: goal,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        viewer,
        warning:
          ranked.candidateIds === null
            ? "No embeddings in this doco yet — reindex first."
            : "No entities match the active filters.",
      });
    }
    const allHits = ranked.hits.map(toJsonSearchHit);

    const stableData = {
      query: q,
      doco_goal: goal,
      viewer,
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
