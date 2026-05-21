// GET /<doco-handle>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. Vector-only ranking (ADR-052).
// Resource route — no default export.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cosineSimilarity, getAllEmbeddingsForDoco, withClient } from "@doco/db";
import { globalPageRank } from "@doco/index";
import { docoPath } from "~/lib/db.server";
import { loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import { etaggedJson } from "~/lib/etag.server";
import {
  type SearchFilters,
  computeFilterFacets,
  parseSearchFilters,
  resolveFilteredCandidates,
} from "~/lib/search-filters.server";

const PLURAL_DIR: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  guidance_article: "guidance_articles",
  node_authoring_article: "node_authoring_articles",
  action: "actions",
  reference: "references",
  eval: "evals",
  idea: "ideas",
  principal: "principals",
  organization: "organizations",
};

function resolveEntityFilePath(docoDir: string, nodeType: string, id: string): string | null {
  const plural = PLURAL_DIR[nodeType] ?? `${nodeType}s`;
  for (const ext of [".md", ".yaml"]) {
    const candidate = join(docoDir, plural, `${id}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Hit {
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

interface TypeFetch {
  table: string;
  nodeType: string;
  selectExtra: string;
  hostLevel: boolean;
  rowToHit(row: Record<string, unknown>, vectorScore: number, docoDir: string): Hit;
}

const TYPE_FETCHES: TypeFetch[] = [
  fetchSpec("decisions", "decision", "summary, lifecycle, created_at", false),
  fetchSpec("intents", "intent", "summary, lifecycle, created_at", false),
  fetchSpec("rules", "rule", "summary, lifecycle, created_at", false),
  fetchSpec("guidance_articles", "guidance_article", "summary, lifecycle, created_at", false),
  fetchSpec(
    "node_authoring_articles",
    "node_authoring_article",
    "summary, lifecycle, created_at",
    false,
  ),
  fetchSpec("actions", "action", "summary, lifecycle, created_at", false),
  fetchSpec("logs", "log", "summary, lifecycle, created_at", false),
  fetchSpec("reference_entities", "reference", "summary, lifecycle, created_at", false),
  fetchSpec("evals", "eval", "summary, lifecycle, created_at", false),
  fetchSpec("ideas", "idea", "summary, lifecycle, created_at", false),
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State node type.
  fetchSpec("states", "state", "summary, lifecycle, created_at", false),
  fetchSpec("principals", "principal", "username, created_at", true, (r, vs, docoDir) => ({
    id: String(r.id),
    node_type: "principal",
    name: (r.username as string) ?? null,
    summary: (r.username as string) ?? "",
    lifecycle: null,
    created_at: (r.created_at as string) ?? null,
    gpr: 0,
    vector_score: vs,
    file_path: resolveEntityFilePath(docoDir, "principal", String(r.id)),
  })),
  fetchSpec("organizations", "organization", "slug, name, created_at", true, (r, vs, docoDir) => ({
    id: String(r.id),
    node_type: "organization",
    name: (r.slug as string) ?? null,
    summary: (r.name as string) ?? "",
    lifecycle: null,
    created_at: (r.created_at as string) ?? null,
    gpr: 0,
    vector_score: vs,
    file_path: resolveEntityFilePath(docoDir, "organization", String(r.id)),
  })),
];

function fetchSpec(
  table: string,
  nodeType: string,
  selectExtra: string,
  hostLevel: boolean,
  custom?: TypeFetch["rowToHit"],
): TypeFetch {
  return {
    table,
    nodeType,
    selectExtra,
    hostLevel,
    rowToHit:
      custom ??
      ((r, vs, docoDir) => ({
        id: String(r.id),
        node_type: nodeType,
        name: null,
        summary: (r.summary as string) ?? "",
        lifecycle: (r.lifecycle as string) ?? null,
        created_at: (r.created_at as string) ?? null,
        gpr: 0,
        vector_score: vs,
        file_path: resolveEntityFilePath(docoDir, nodeType, String(r.id)),
      })),
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
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForRead(request, handle);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const docoDir = docoPath(handle);

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

    const candidateIds = await resolveFilteredCandidates(c, ctx.meta.docoId, filters);
    const all = (await getAllEmbeddingsForDoco(ctx.meta.docoId)).filter(
      (e) => candidateIds === null || candidateIds.has(e.entity_id),
    );
    if (all.length === 0) {
      return Response.json({
        query: q,
        count: 0,
        duration_ms: Math.round(performance.now() - start),
        filters: filtersOut,
        hits: [],
        warning:
          candidateIds === null
            ? "No embeddings in this Doco yet — reindex first."
            : "No entities match the active filters.",
      });
    }
    const scored = all.map((e) => ({
      entity_id: e.entity_id,
      score: cosineSimilarity(queryEmbedding, e.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, filters.limit);
    const topById = new Map(top.map((t) => [t.entity_id, t.score]));
    const topIds = top.map((t) => t.entity_id);

    const allHits: Hit[] = [];
    for (const spec of TYPE_FETCHES) {
      const sql = spec.hostLevel
        ? `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[])`
        : `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[]) AND doco_id = $2`;
      const params = spec.hostLevel ? [topIds] : [topIds, ctx.meta.docoId];
      const rows = (await c.query(sql, params)).rows;
      for (const row of rows) {
        const id = String(row.id);
        const vs = Math.round((topById.get(id) ?? 0) * 10000) / 10000;
        allHits.push(spec.rowToHit(row as Record<string, unknown>, vs, docoDir));
      }
    }

    // Global PageRank — pull all edges for this Doco.
    const edgeRows = (
      await c.query<{ from_id: string; to_id: string; edge_type: string; attribution: string }>(
        "SELECT from_id, to_id, edge_type, attribution FROM edges WHERE doco_id = $1",
        [ctx.meta.docoId],
      )
    ).rows;
    const gpr = globalPageRank(
      edgeRows.map((e) => ({
        from: e.from_id,
        to: e.to_id,
        edge_type: e.edge_type,
        attribution: e.attribution as "explicit" | "doco-auto",
      })),
      { alpha: 0.85 },
    );
    const gprById = new Map<string, number>();
    for (const p of gpr) gprById.set(p.id, p.score);
    for (const h of allHits) h.gpr = gprById.get(h.id) ?? 0;
    allHits.sort((a, b) => b.vector_score - a.vector_score);

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
