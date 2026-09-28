// GET /<doco-handle>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. Hybrid ranking: vector similarity
// with a full-text floor (ADR-052) so un-embedded nodes are still found.
// A Slack-mirror Doco also returns matching Slack messages (`slack_messages`),
// a Notion-mirror Doco matching pages (`notion_pages`), unless the caller
// filters by node type or lifecycle.
// Resource route — no default export.
import { withClient } from "@doco/db";
import { loadAgentDisplayIdentity } from "~/lib/agent-identity.server";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { etaggedJson } from "~/lib/etag.server";
import { buildSearchDisplay } from "~/lib/indicator-lines";
import { searchNotionMirror } from "~/lib/notion-mirror-read.server";
import {
  type SearchFilters,
  computeFilterFacets,
  parseSearchFilters,
} from "~/lib/search-filters.server";
import { type SearchHit, hybridSearch } from "~/lib/search.server";
import { searchSlackMirror } from "~/lib/slack-mirror-read.server";

const SLACK_MESSAGE_LIMIT = 20;
const NOTION_PAGE_LIMIT = 20;

interface JsonSearchHit {
  id: string;
  node_type: string;
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
      node_type: filters.nodeType,
      limit: filters.limit,
    };

    if (!q) {
      const duration_ms = Math.round(performance.now() - start);
      return Response.json({
        query: "",
        doco_goal: goal,
        viewer,
        count: 0,
        duration_ms,
        display: buildSearchDisplay({
          indicatorPrefix: viewer?.indicator_prefix,
          count: 0,
          durationMs: duration_ms,
          label: handle,
        }),
        filters: filtersOut,
        hits: [],
        slack_messages: [],
        notion_pages: [],
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
      { queryText: q, queryEmbedding, modelId: provider?.modelId },
      filters,
      filters.limit,
    );
    const allHits = hits.map(toJsonSearchHit);
    const withMirrors = !url.searchParams.has("node_type") && !url.searchParams.has("lifecycle");
    const slackMessages = withMirrors
      ? await searchSlackMirror(c, ctx.meta.docoId, q, Math.min(filters.limit, SLACK_MESSAGE_LIMIT))
      : [];
    const notionPages = withMirrors
      ? await searchNotionMirror(c, ctx.meta.docoId, q, Math.min(filters.limit, NOTION_PAGE_LIMIT))
      : [];
    const count = allHits.length + slackMessages.length + notionPages.length;

    if (count === 0) {
      const duration_ms = Math.round(performance.now() - start);
      return Response.json({
        query: q,
        doco_goal: goal,
        count: 0,
        duration_ms,
        display: buildSearchDisplay({
          indicatorPrefix: viewer?.indicator_prefix,
          count: 0,
          durationMs: duration_ms,
          label: handle,
        }),
        filters: filtersOut,
        hits: [],
        slack_messages: [],
        notion_pages: [],
        viewer,
        warning: semanticWarning ?? "No entities match the query or the active filters.",
      });
    }

    const stableData = {
      query: q,
      doco_goal: goal,
      viewer,
      count,
      filters: filtersOut,
      hits: allHits,
      slack_messages: slackMessages,
      notion_pages: notionPages,
      ...(semanticWarning ? { warning: semanticWarning } : {}),
    };
    const duration_ms = Math.round(performance.now() - start);
    return etaggedJson(
      request,
      {
        ...stableData,
        duration_ms,
        // `display` carries the wall-clock duration, so it stays OUT of
        // `stableData` (the etag basis) — otherwise the etag would churn
        // every request.
        display: buildSearchDisplay({
          indicatorPrefix: viewer?.indicator_prefix,
          count,
          durationMs: duration_ms,
          label: handle,
        }),
      },
      { stableData },
    );
  });
}
