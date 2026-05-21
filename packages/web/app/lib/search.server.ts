import { cosineSimilarity, getAllEmbeddingsForDoco } from "@doco/db";
import { globalPageRank } from "@doco/index";
import type { PoolClient } from "pg";
import { type SearchFilters, resolveFilteredCandidates } from "~/lib/search-filters.server";

export interface SearchHit {
  id: string;
  node_type: string;
  summary?: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  gpr: number;
  vector_score: number | null;
}

export interface SearchTypeSpec {
  table: string;
  nodeType: string;
  selectExtra: string;
  hostLevel: boolean;
  toHit(row: Record<string, unknown>, vectorScore: number | null): Omit<SearchHit, "gpr">;
}

function entitySpec(table: string, nodeType: string): SearchTypeSpec {
  return {
    table,
    nodeType,
    selectExtra: "summary, lifecycle, created_at",
    hostLevel: false,
    toHit: (row, score) => ({
      id: String(row.id),
      node_type: nodeType,
      summary: (row.summary as string) ?? "",
      name: null,
      lifecycle: (row.lifecycle as string) ?? null,
      created_at: (row.created_at as string) ?? null,
      vector_score: score,
    }),
  };
}

export const SEARCH_TYPE_SPECS: SearchTypeSpec[] = [
  entitySpec("decisions", "decision"),
  entitySpec("intents", "intent"),
  entitySpec("rules", "rule"),
  entitySpec("guidance_articles", "guidance_article"),
  entitySpec("node_authoring_articles", "node_authoring_article"),
  entitySpec("actions", "action"),
  entitySpec("logs", "log"),
  entitySpec("reference_entities", "reference"),
  entitySpec("evals", "eval"),
  entitySpec("ideas", "idea"),
  entitySpec("states", "state"),
  {
    table: "principals",
    nodeType: "principal",
    selectExtra: "username, created_at",
    hostLevel: true,
    toHit: (row, score) => ({
      id: String(row.id),
      node_type: "principal",
      summary: (row.username as string) ?? "",
      name: (row.username as string) ?? null,
      lifecycle: null,
      created_at: (row.created_at as string) ?? null,
      vector_score: score,
    }),
  },
  {
    table: "organizations",
    nodeType: "organization",
    selectExtra: "slug, name, created_at",
    hostLevel: true,
    toHit: (row, score) => ({
      id: String(row.id),
      node_type: "organization",
      summary: (row.name as string) ?? "",
      name: (row.slug as string) ?? null,
      lifecycle: null,
      created_at: (row.created_at as string) ?? null,
      vector_score: score,
    }),
  },
];

const FILTER_PARAM_NAMES = ["lifecycle", "node_type"] as const;

export function hasExplicitSearchFilter(params: URLSearchParams): boolean {
  return FILTER_PARAM_NAMES.some((name) => params.has(name));
}

export async function loadFilteredSearchHits(
  c: PoolClient,
  docoId: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const candidateIds = await resolveFilteredCandidates(c, docoId, filters);
  if (candidateIds !== null && candidateIds.size === 0) return [];

  const ids =
    candidateIds === null ? await loadAllDocoEntityIds(c, docoId) : Array.from(candidateIds);
  const hits = await hydrateSearchHits(c, ids, docoId, null);
  await attachSearchGlobalPageRank(c, docoId, hits);
  hits.sort((a, b) => {
    const byCreated = createdTime(b.created_at) - createdTime(a.created_at);
    if (byCreated !== 0) return byCreated;
    const byGpr = b.gpr - a.gpr;
    if (byGpr !== 0) return byGpr;
    return a.id.localeCompare(b.id);
  });
  return hits;
}

export async function loadAllDocoEntityIds(c: PoolClient, docoId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of SEARCH_TYPE_SPECS) {
    if (spec.hostLevel) continue;
    const rows = (
      await c.query<{ id: string }>(`SELECT id FROM ${spec.table} WHERE doco_id = $1`, [docoId])
    ).rows;
    for (const row of rows) ids.push(row.id);
  }
  return ids;
}

export async function hydrateSearchHits(
  c: PoolClient,
  ids: string[],
  docoId: string,
  scoreById: Map<string, number> | null,
): Promise<SearchHit[]> {
  if (ids.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const spec of SEARCH_TYPE_SPECS) {
    const sql = spec.hostLevel
      ? `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[])`
      : `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[]) AND doco_id = $2`;
    const params = spec.hostLevel ? [ids] : [ids, docoId];
    const rows = (await c.query(sql, params)).rows;
    for (const row of rows) {
      const rawScore = scoreById?.get(String(row.id));
      const score = typeof rawScore === "number" ? Math.round(rawScore * 10000) / 10000 : null;
      const hit = spec.toHit(row as Record<string, unknown>, score);
      hits.push({ ...hit, gpr: 0 });
    }
  }
  return hits;
}

export async function attachSearchGlobalPageRank(
  c: PoolClient,
  docoId: string,
  hits: SearchHit[],
): Promise<void> {
  if (hits.length === 0) return;
  const edgeRows = (
    await c.query<{ from_id: string; to_id: string; edge_type: string; attribution: string }>(
      "SELECT from_id, to_id, edge_type, attribution FROM edges WHERE doco_id = $1",
      [docoId],
    )
  ).rows;
  const gpr = globalPageRank(
    edgeRows.map((edge) => ({
      from: edge.from_id,
      to: edge.to_id,
      edge_type: edge.edge_type,
      attribution: edge.attribution as "explicit" | "doco-auto",
    })),
    { alpha: 0.85 },
  );
  const gprById = new Map<string, number>();
  for (const point of gpr) gprById.set(point.id, point.score);
  for (const hit of hits) hit.gpr = gprById.get(hit.id) ?? 0;
}

export async function rankSearchEmbeddings(
  c: PoolClient,
  docoId: string,
  queryEmbedding: Float32Array,
  filters: SearchFilters,
  limit?: number,
): Promise<{ hits: SearchHit[]; candidateIds: Set<string> | null }> {
  const candidateIds = await resolveFilteredCandidates(c, docoId, filters);
  const embeddings = (await getAllEmbeddingsForDoco(docoId)).filter(
    (embedding) => candidateIds === null || candidateIds.has(embedding.entity_id),
  );
  if (embeddings.length === 0) return { hits: [], candidateIds };

  const scored = embeddings.map((embedding) => ({
    entity_id: embedding.entity_id,
    score: cosineSimilarity(queryEmbedding, embedding.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  const selected = typeof limit === "number" ? scored.slice(0, limit) : scored;
  const scoreById = new Map(selected.map((item) => [item.entity_id, item.score]));
  const ids = selected.map((item) => item.entity_id);
  const hits = await hydrateSearchHits(c, ids, docoId, scoreById);
  await attachSearchGlobalPageRank(c, docoId, hits);
  hits.sort((a, b) => (b.vector_score ?? 0) - (a.vector_score ?? 0));
  return { hits, candidateIds };
}

function createdTime(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
