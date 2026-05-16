// GET /<owner>/<doco>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. Vector-only ranking (ADR-052).
// Resource route — no default export.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { cosineSimilarity, getAllEmbeddingsForDoco, withClient } from "@doco/db";
import { globalPageRank } from "@doco/index";
import { docoPath } from "~/lib/db.server";
import { etaggedJson } from "~/lib/etag.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import {
  computeFilterFacets,
  parseSearchFilters,
  resolveFilteredCandidates,
  type SearchFilters,
} from "~/lib/search-filters.server";

const PLURAL_DIR: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  reference: "references",
  scope: "scopes",
  eval: "evals",
  idea: "ideas",
  principal: "principals",
  organization: "organizations",
};

function resolveEntityFilePath(
  docoDir: string,
  nodeType: string,
  id: string,
): string | null {
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
  summary: string;
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
  rowToHit(
    row: Record<string, unknown>,
    vectorScore: number,
    docoDir: string,
  ): Hit;
}

const TYPE_FETCHES: TypeFetch[] = [
  fetchSpec("decisions", "decision", "summary, lifecycle, created_at", false),
  fetchSpec("intents", "intent", "summary, lifecycle, created_at", false),
  fetchSpec("rules", "rule", "summary, lifecycle, created_at", false),
  fetchSpec("actions", "action", "summary, lifecycle, created_at", false),
  fetchSpec("logs", "log", "summary, lifecycle, created_at", false),
  fetchSpec("reference_entities", "reference", "summary, lifecycle, created_at", false),
  fetchSpec(
    "scopes",
    "scope",
    "name, summary, lifecycle, created_at",
    false,
    (r, vs, docoDir) => ({
      id: String(r.id),
      node_type: "scope",
      name: (r.name as string) ?? null,
      summary: (r.summary as string) ?? "",
      lifecycle: (r.lifecycle as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      gpr: 0,
      vector_score: vs,
      file_path: resolveEntityFilePath(docoDir, "scope", String(r.id)),
    }),
  ),
  fetchSpec("evals", "eval", "summary, lifecycle, created_at", false),
  fetchSpec("ideas", "idea", "summary, lifecycle, created_at", false),
  fetchSpec(
    "principals",
    "principal",
    "username, display_name, created_at",
    true,
    (r, vs, docoDir) => ({
      id: String(r.id),
      node_type: "principal",
      name: (r.username as string) ?? null,
      summary: (r.display_name as string) ?? "",
      lifecycle: null,
      created_at: (r.created_at as string) ?? null,
      gpr: 0,
      vector_score: vs,
      file_path: resolveEntityFilePath(docoDir, "principal", String(r.id)),
    }),
  ),
  fetchSpec(
    "organizations",
    "organization",
    "slug, name, created_at",
    true,
    (r, vs, docoDir) => ({
      id: String(r.id),
      node_type: "organization",
      name: (r.slug as string) ?? null,
      summary: (r.name as string) ?? "",
      lifecycle: null,
      created_at: (r.created_at as string) ?? null,
      gpr: 0,
      vector_score: vs,
      file_path: resolveEntityFilePath(docoDir, "organization", String(r.id)),
    }),
  ),
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
  params: { ownerSlug: string; docoSlug: string };
}) {
  const start = performance.now();
  const { ownerSlug, docoSlug } = params;
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const docoDir = docoPath(ownerSlug, docoSlug);

  return withClient(async (c) => {
    const facets = await computeFilterFacets(c, ctx.meta.docoId);
    const filters: SearchFilters = parseSearchFilters(url.searchParams, facets);

    const filtersOut = {
      lifecycle: filters.lifecycle,
      node_type: filters.nodeType,
      scope: filters.scope,
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
        `SELECT from_id, to_id, edge_type, attribution FROM edges WHERE doco_id = $1`,
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

    // Pin Constitution + mandatory scopes (ADR-136, ADR-129).
    const wantsScope =
      filters.nodeType === null || filters.nodeType.includes("scope");
    if (wantsScope) {
      await applyScopePins(c, ctx.meta.docoId, allHits, scored, gprById, docoDir);
    }

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

async function applyScopePins(
  c: PoolClient,
  docoId: string,
  allHits: Hit[],
  scored: { entity_id: string; score: number }[],
  gprById: Map<string, number>,
  docoDir: string,
): Promise<void> {
  const constRow = (
    await c.query<{
      id: string;
      name: string;
      summary: string | null;
      created_at: string;
      raw_yaml: string;
    }>(
      `SELECT id, name, summary, created_at, raw_yaml
         FROM scopes WHERE doco_id = $1 AND name = 'constitution' LIMIT 1`,
      [docoId],
    )
  ).rows[0];
  if (!constRow) return;

  const pinScope = (row: {
    id: string;
    name: string;
    summary: string | null;
    created_at: string;
  }) => {
    const existingIdx = allHits.findIndex((h) => h.id === row.id);
    if (existingIdx >= 0) {
      const [hit] = allHits.splice(existingIdx, 1);
      hit.pinned = true;
      allHits.unshift(hit);
    } else {
      const scoreEntry = scored.find((s) => s.entity_id === row.id);
      allHits.unshift({
        id: row.id,
        node_type: "scope",
        name: row.name,
        summary: row.summary ?? "",
        lifecycle: null,
        created_at: row.created_at,
        gpr: gprById.get(row.id) ?? 0,
        vector_score: scoreEntry
          ? Math.round(scoreEntry.score * 10000) / 10000
          : 0,
        file_path: resolveEntityFilePath(docoDir, "scope", row.id),
        pinned: true,
      });
    }
  };

  // Parse Constitution YAML for mandatory_scope rules.
  let mandatoryIds: string[] = [];
  try {
    const { parse: parseYaml } = await import("yaml");
    const parsed = parseYaml(constRow.raw_yaml) as { rules?: unknown };
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    for (const r of rules as Record<string, unknown>[]) {
      if (r.kind !== "mandatory_scope") continue;
      if (Array.isArray(r.scope_ids)) {
        for (const sid of r.scope_ids) {
          if (typeof sid === "string") mandatoryIds.push(sid);
        }
      } else if (typeof r.scope_id === "string") {
        mandatoryIds.push(r.scope_id);
      }
    }
  } catch {
    mandatoryIds = [];
  }

  if (mandatoryIds.length > 0) {
    const mandatoryRows = (
      await c.query<{
        id: string;
        name: string;
        summary: string | null;
        created_at: string;
      }>(
        `SELECT id, name, summary, created_at FROM scopes
          WHERE doco_id = $1 AND id = ANY($2::text[]) AND id != $3`,
        [docoId, mandatoryIds, constRow.id],
      )
    ).rows;
    for (const row of mandatoryRows) pinScope(row);
  }

  pinScope({
    id: constRow.id,
    name: constRow.name,
    summary: constRow.summary,
    created_at: constRow.created_at,
  });
}
