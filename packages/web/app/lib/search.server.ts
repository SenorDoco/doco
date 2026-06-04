import { cosineSimilarity, getAllEmbeddingsForDoco } from "@doco/db";
import { globalPageRank } from "@doco/index";
import { NODE_TYPES } from "@doco/shared";
import type { PoolClient } from "pg";
import { type SearchFilters, resolveFilteredCandidates } from "~/lib/search-filters.server";

export interface SearchHit {
  id: string;
  entity_type: string;
  summary?: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  gpr: number;
  vector_score: number | null;
}

export interface SearchTypeSpec {
  // The relation each spec reads from. Node types read from the unified
  // `nodes` table filtered by `nodeType`; host-level types (workspace)
  // read from their own table named here.
  table: string;
  // `node_type` discriminator on `nodes`, or null for host-level types
  // that don't live in `nodes` (workspace).
  nodeType: string | null;
  entityType: string;
  selectExtra: string;
  hostLevel: boolean;
  toHit(row: Record<string, unknown>, vectorScore: number | null): Omit<SearchHit, "gpr">;
}

function entitySpec(entityType: string): SearchTypeSpec {
  // Post-collapse: every node type lives in `nodes`, prose in the
  // shared `prose` column. The projected alias stays `summary` so the
  // rest of the search hit shape doesn't change.
  return {
    table: "nodes",
    nodeType: entityType,
    entityType,
    selectExtra: `split_part(prose, E'\n', 1) AS summary, lifecycle, created_at`,
    hostLevel: false,
    toHit: (row, score) => ({
      id: String(row.id),
      entity_type: entityType,
      summary: (row.summary as string) ?? "",
      name: null,
      lifecycle: (row.lifecycle as string) ?? null,
      created_at: (row.created_at as string) ?? null,
      vector_score: score,
    }),
  };
}

// Note types only — policies are not nodes
// and do not participate in node search/ranking. To fetch policies,
// hit /<handle>/api/policies.json or read the bootstrap payload.
export const SEARCH_TYPE_SPECS: SearchTypeSpec[] = [
  ...NODE_TYPES.filter((type) => type !== "principal").map((type) => entitySpec(type)),
  {
    table: "nodes",
    nodeType: "principal",
    entityType: "principal",
    // Slim-down: principal label lives in `prose` now (no `name` column).
    selectExtra: "prose AS name, created_at",
    hostLevel: false,
    toHit: (row, score) => ({
      id: String(row.id),
      entity_type: "principal",
      summary: (row.name as string) ?? "",
      name: (row.name as string) ?? null,
      lifecycle: null,
      created_at: (row.created_at as string) ?? null,
      vector_score: score,
    }),
  },
  {
    table: "workspaces",
    nodeType: null,
    entityType: "workspace",
    selectExtra: "handle, name, created_at",
    hostLevel: true,
    toHit: (row, score) => ({
      id: String(row.id),
      entity_type: "workspace",
      summary: (row.name as string) ?? "",
      name: (row.handle as string) ?? null,
      lifecycle: null,
      created_at: (row.created_at as string) ?? null,
      vector_score: score,
    }),
  },
];

const FILTER_PARAM_NAMES = ["lifecycle", "entity_type"] as const;

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
    // Node types live in the unified `nodes` table, scoped by node_type.
    const rows = (
      await c.query<{ id: string }>("SELECT id FROM nodes WHERE node_type = $1 AND doco_id = $2", [
        spec.nodeType,
        docoId,
      ])
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
    // Host-level types (workspace) keep their own table; node types
    // read from the unified `nodes` table, scoped by node_type.
    const sql = spec.hostLevel
      ? `SELECT id, ${spec.selectExtra} FROM ${spec.table} WHERE id = ANY($1::text[])`
      : `SELECT id, ${spec.selectExtra} FROM nodes WHERE id = ANY($1::text[]) AND doco_id = $2 AND node_type = $3`;
    const params = spec.hostLevel ? [ids] : [ids, docoId, spec.nodeType];
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
    await c.query<{ from_id: string; to_id: string; edge_type: string }>(
      "SELECT from_id, to_id, edge_type FROM edges WHERE doco_id = $1",
      [docoId],
    )
  ).rows;
  // Directed: an edge's direction is meaningful here (e.g. an event
  // "serves" an intent as from=event → to=intent), so the intent that many
  // nodes point at accumulates rank as an authority rather than having its
  // mass diluted across a symmetrized star. See ADR / globalPageRank docs.
  const gpr = globalPageRank(
    edgeRows.map((s) => ({
      from: s.from_id,
      to: s.to_id,
      edge_type: s.edge_type,
    })),
    { alpha: 0.85, directed: true },
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

/**
 * Lexical (full-text) ranking over `entity_fts_nodes` — the index that's
 * written inline with every capture, so it covers nodes the vector index
 * never got: content-thin drafts and rows whose best-effort embedding pass
 * lagged or silently failed. Same lifecycle/type filtering as the vector
 * path (via `resolveFilteredCandidates`, which reads `nodes` directly, so
 * un-embedded nodes are eligible). Returns hits in descending FTS rank.
 */
export async function rankSearchFts(
  c: PoolClient,
  docoId: string,
  queryText: string,
  filters: SearchFilters,
  limit?: number,
): Promise<SearchHit[]> {
  const q = queryText.trim();
  if (!q) return [];
  const candidateIds = await resolveFilteredCandidates(c, docoId, filters);
  if (candidateIds !== null && candidateIds.size === 0) return [];

  const rows = (
    await c.query<{ entity_id: string; rank: number }>(
      `WITH query AS (SELECT websearch_to_tsquery('english', $2) AS q)
       SELECT f.entity_id, ts_rank_cd(f.search_tsv, query.q) AS rank
         FROM entity_fts_nodes f CROSS JOIN query
        WHERE f.doco_id = $1 AND f.search_tsv @@ query.q
        ORDER BY rank DESC, f.entity_id`,
      [docoId, q],
    )
  ).rows;

  let ids = rows.map((r) => r.entity_id);
  if (candidateIds !== null) ids = ids.filter((id) => candidateIds.has(id));
  if (typeof limit === "number") ids = ids.slice(0, limit);
  if (ids.length === 0) return [];

  const hits = await hydrateSearchHits(c, ids, docoId, null);
  await attachSearchGlobalPageRank(c, docoId, hits);
  // hydrateSearchHits returns rows grouped by spec; restore FTS rank order.
  const rankById = new Map(ids.map((id, i) => [id, i]));
  hits.sort((a, b) => (rankById.get(a.id) ?? 0) - (rankById.get(b.id) ?? 0));
  return hits;
}

// Reciprocal Rank Fusion constants. `RRF_K` damps the contribution of any
// single ranker (the standard value is 60) so that being #1 in one list is a
// nudge, not a veto. `PAGERANK_RRF_WEIGHT` scales how loudly global authority
// (gpr) speaks relative to a content ranker (cosine / FTS, each weight 1.0):
// 0 disables it, 1 makes it a peer. Kept below 1 so relevance leads and
// authority breaks ties / lifts corroborated hits. Tune against the
// retrieval eval harness in `packages/index`.
export const RRF_K = 60;
export const PAGERANK_RRF_WEIGHT = 0.5;

export interface RrfOptions {
  k?: number;
  pagerankWeight?: number;
}

/**
 * Fuse the cosine, full-text, and global-PageRank signals via Reciprocal Rank
 * Fusion. Each hit scores `Σ wᵢ / (k + rankᵢ)` over the rankers that placed it:
 * its cosine rank (position in `vectorHits`), its FTS rank (position in
 * `ftsHits`), and its PageRank rank (position when the union is ordered by
 * `gpr` desc). RRF compares by *rank position*, sidestepping the scale
 * mismatch between cosine (~[0,0.8]) and PageRank (≈1/N, power-law skewed) that
 * makes a raw weighted sum unusable. A hit corroborated by two content rankers
 * outranks one seen by a single ranker; PageRank then lifts authorities. Result
 * is the deduped union sorted by descending fused score, `id` as a stable
 * tiebreak, capped to `limit`. Pure.
 */
export function mergeSearchHits(
  vectorHits: SearchHit[],
  ftsHits: SearchHit[],
  limit?: number,
  options: RrfOptions = {},
): SearchHit[] {
  const k = options.k ?? RRF_K;
  const pagerankWeight = options.pagerankWeight ?? PAGERANK_RRF_WEIGHT;

  // Deduped union; first-seen object wins (it carries gpr / vector_score).
  const byId = new Map<string, SearchHit>();
  for (const hit of [...vectorHits, ...ftsHits]) {
    if (!byId.has(hit.id)) byId.set(hit.id, hit);
  }

  // Rank position within each content ranker's list (0-based, lower is better).
  const rankIn = (hits: SearchHit[]): Map<string, number> => {
    const ranks = new Map<string, number>();
    hits.forEach((hit, i) => {
      if (!ranks.has(hit.id)) ranks.set(hit.id, i);
    });
    return ranks;
  };
  const cosineRank = rankIn(vectorHits);
  const ftsRank = rankIn(ftsHits);

  // PageRank rank over the union — every hit carries a gpr, so this ranker
  // covers the whole shortlist (including FTS-only, un-embedded nodes).
  const pagerankRank = new Map<string, number>();
  if (pagerankWeight !== 0) {
    [...byId.values()]
      .sort((a, b) => b.gpr - a.gpr || a.id.localeCompare(b.id))
      .forEach((hit, i) => pagerankRank.set(hit.id, i));
  }

  const fusedScore = (id: string): number => {
    let score = 0;
    const cr = cosineRank.get(id);
    if (cr !== undefined) score += 1 / (k + cr);
    const fr = ftsRank.get(id);
    if (fr !== undefined) score += 1 / (k + fr);
    const pr = pagerankRank.get(id);
    if (pr !== undefined) score += pagerankWeight / (k + pr);
    return score;
  };

  const merged = [...byId.values()].sort(
    (a, b) => fusedScore(b.id) - fusedScore(a.id) || a.id.localeCompare(b.id),
  );
  return typeof limit === "number" ? merged.slice(0, limit) : merged;
}

/**
 * Hybrid search: semantic ranking with a lexical floor. When a query
 * embedding is supplied, rank by cosine and union in FTS matches the vector
 * index lacks; with no embedding (provider absent or failed), fall back to
 * FTS alone so search still works instead of returning nothing. `usedVector`
 * tells the caller whether semantic ranking was applied.
 */
export async function hybridSearch(
  c: PoolClient,
  docoId: string,
  query: { queryText: string; queryEmbedding: Float32Array | null },
  filters: SearchFilters,
  limit?: number,
): Promise<{ hits: SearchHit[]; candidateIds: Set<string> | null; usedVector: boolean }> {
  let vectorHits: SearchHit[] = [];
  let candidateIds: Set<string> | null = null;
  const usedVector = query.queryEmbedding !== null;
  if (query.queryEmbedding) {
    const ranked = await rankSearchEmbeddings(c, docoId, query.queryEmbedding, filters, limit);
    vectorHits = ranked.hits;
    candidateIds = ranked.candidateIds;
  }
  const ftsHits = await rankSearchFts(c, docoId, query.queryText, filters, limit);
  return { hits: mergeSearchHits(vectorHits, ftsHits, limit), candidateIds, usedVector };
}

function createdTime(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
