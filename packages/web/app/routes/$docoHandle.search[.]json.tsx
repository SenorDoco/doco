// GET /<doco-handle>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. Hybrid ranking: vector similarity
// with a full-text floor (ADR-052) so un-embedded nodes are still found.
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
import { type SearchHit, hybridSearch } from "~/lib/search.server";

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

    // Hybrid: semantic ranking when an embedding provider is configured, with
    // a full-text floor so nodes the vector index never got (content-thin
    // drafts, or rows whose best-effort embedding pass failed/lagged) are
    // still found. With no/failed provider, degrade to keyword search rather
    // than returning nothing.
    const provider = getDocoEmbeddingProvider();
    let queryEmbedding: Float32Array | null = null;
    let semanticWarning: string | null = null;
    if (!provider) {
      semanticWarning =
        "Semantic ranking unavailable (no embedding provider configured); showing keyword matches.";
    } else {
      try {
        const [v] = await provider.embed([q], "query");
        if (v && v.length > 0) queryEmbedding = v;
        else
          semanticWarning =
            "Semantic ranking unavailable (provider returned an empty embedding); showing keyword matches.";
      } catch (e) {
        semanticWarning = `Semantic ranking unavailable (${(e as Error).message}); showing keyword matches.`;
      }
    }

    const { hits } = await hybridSearch(
      c,
      ctx.meta.docoId,
      { queryText: q, queryEmbedding },
      filters,
      filters.limit,
    );
    const allHits = hits.map(toJsonSearchHit);

    if (allHits.length === 0) {
      return Response.json({
        query: q,
        doco_goal: goal,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        viewer,
        warning: semanticWarning ?? "No entities match the query or the active filters.",
      });
    }

    const stableData = {
      query: q,
      doco_goal: goal,
      viewer,
      count: allHits.length,
      filters: filtersOut,
      hits: allHits,
      ...(semanticWarning ? { warning: semanticWarning } : {}),
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
