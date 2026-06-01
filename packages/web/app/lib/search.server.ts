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
  // `nodes` table filtered by `nodeType`; host-level types (organization)
  // read from their own table named here.
  table: string;
  // `node_type` discriminator on `nodes`, or null for host-level types
  // that don't live in `nodes` (organization).
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
    selectExtra: "name, created_at",
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
    table: "organizations",
    nodeType: null,
    entityType: "organization",
    selectExtra: "handle, name, created_at",
    hostLevel: true,
    toHit: (row, score) => ({
      id: String(row.id),
      entity_type: "organization",
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
    // Host-level types (organization) keep their own table; node types
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
  const gpr = globalPageRank(
    edgeRows.map((s) => ({
      from: s.from_id,
      to: s.to_id,
      edge_type: s.edge_type,
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
