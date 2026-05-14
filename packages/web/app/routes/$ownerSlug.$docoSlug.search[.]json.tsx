// GET /<owner>/<doco>/search.json — agent-facing query endpoint.
//
// Agents call this at the START of every new task to find nodes in the
// Doco relevant to the user's request. The response carries the count
// of hits + the wall-clock duration on the server so the agent can
// render the "Querying… / Connected. NN relevant nodes found (X.Xs)"
// indicator at the top of their reply.
//
// Ranking is vector-only (cosine over entity embeddings, ADR-052,
// supersedes ADR-030). One provider call per request embeds the query;
// cosine is computed against every entity in the Doco; the top-N by
// score is returned ordered descending. No FTS layer, no find_rules
// sidecar — search is one thing.
//
// Resource route — no default export.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cosineSimilarity, getAllEmbeddings, globalPageRank } from "@doco/index";
import { docoPath, openDocoDb } from "~/lib/db.server";
import { etaggedJson } from "~/lib/etag.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { getDocoEmbeddingProvider } from "~/lib/embedding-provider.server";
import {
  computeFilterFacets,
  parseSearchFilters,
  resolveFilteredCandidates,
  type SearchFilters,
} from "~/lib/search-filters.server";

/**
 * Per-node-type directory map (matches the on-disk convention every
 * capture helper writes to). The `reasoning` type has no plural — its
 * dir is `reasoning` not `reasonings`.
 */
const PLURAL_DIR: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  reasoning: "reasoning",
  reference: "references",
  scope: "scopes",
  eval: "evals",
  idea: "ideas",
  principal: "principals",
  organization: "organizations",
};

/**
 * Resolve an entity's on-disk file path. Tries `.md` first (Decision,
 * Intent, Rule, Action, Reasoning, Idea, Eval store body in markdown),
 * then `.yaml` (Scope, Reference, Principal, Organization). Returns
 * null if neither exists — usually means the index is stale relative
 * to disk.
 */
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
  /** Scope hits carry their `name` — the handle agents use in `scopes: [user-flows]`. Other types leave it null. */
  name: string | null;
  summary: string;
  lifecycle: string | null;
  created_at: string | null;
  /** Global PageRank — graph centrality, attached for downstream consumers. */
  gpr: number;
  /**
   * Cosine similarity between the query embedding and this entity's
   * stored embedding (0..1, rounded to 4 decimals). Always populated
   * on a successful vector search — hits are ranked by this value.
   * Per ADR-052.
   */
  vector_score: number;
  /**
   * Absolute path to the entity's YAML/markdown file on disk. Saves the
   * agent a filesystem grep — they can read the file directly.
   */
  file_path: string | null;
  /**
   * True when this hit was force-included regardless of cosine rank.
   * Pinned hits: the Constitution scope (per ADR-136 — its rules can
   * block any capture) and any scope the Constitution names in a
   * `mandatory_scope` rule.
   */
  pinned?: boolean;
}

function pickAvailableColumns(
  db: import("better-sqlite3").Database,
  table: string,
  wanted: string[],
): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const have = new Set(rows.map((r) => r.name));
  return wanted.filter((c) => have.has(c));
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
  await loadDocoForRead(request, ownerSlug, docoSlug); // 404 if private + non-member
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  const db = openDocoDb(ownerSlug, docoSlug);
  try {
    // Facets feed `parseSearchFilters` so the lifecycle default adapts
    // to whatever values are present on disk ("active", "succeeded", …).
    const facets = computeFilterFacets(db);
    const filters: SearchFilters = parseSearchFilters(url.searchParams, facets);

    // Emit the applied filter spec on every response so the caller can see
    // what was used (helpful when defaults kick in for an omitted param).
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
    // Step 1: embed the query.
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

    // Step 2: resolve filter constraints to a candidate id set BEFORE
    // computing cosine, so we don't waste work on entities the user
    // filtered out. `null` = no filter (every entity is a candidate).
    const candidateIds = resolveFilteredCandidates(db, filters);

    // Step 3: cosine against the candidate set (or every entity when
    // unfiltered). At Tier B scale (≤ 100k entities, ADR-049) full-scan
    // is fine.
    const all = getAllEmbeddings(db).filter(
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
    const scored: { entity_id: string; score: number }[] = [];
    for (const e of all) {
      scored.push({
        entity_id: e.entity_id,
        score: cosineSimilarity(queryEmbedding, e.embedding),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, filters.limit);

    // Step 3: hydrate per-hit metadata + node_type from the per-type tables.
    // The embeddings table doesn't carry node_type, so we resolve it by
    // checking each per-type table by id (fast: each top-N entry is one
    // PK lookup per type until found).
    const nodeTypes = [
      "decision",
      "intent",
      "rule",
      "action",
      "reasoning",
      "reference",
      "scope",
      "eval",
      "idea",
      "principal",
      "organization",
    ] as const;
    const topById = new Map(top.map((t) => [t.entity_id, t.score]));
    const hitsByType = new Map<string, Hit[]>();
    for (const nodeType of nodeTypes) {
      const cols = pickAvailableColumns(db, nodeType, [
        "id",
        "name",
        "summary",
        "lifecycle",
        "created_at",
      ]);
      const placeholders = top.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT ${cols.join(", ")} FROM ${nodeType} WHERE id IN (${placeholders})`)
        .all(...top.map((t) => t.entity_id)) as {
        id: string;
        name?: string | null;
        summary?: string | null;
        lifecycle?: string | null;
        created_at?: string | null;
      }[];
      if (rows.length === 0) continue;
      const arr: Hit[] = rows.map((row) => ({
        id: row.id,
        node_type: nodeType,
        name: row.name ?? null,
        summary: row.summary ?? "",
        lifecycle: row.lifecycle ?? null,
        created_at: row.created_at ?? null,
        gpr: 0,
        vector_score: Math.round((topById.get(row.id) ?? 0) * 10000) / 10000,
        file_path: resolveEntityFilePath(docoPath(ownerSlug, docoSlug), nodeType, row.id),
      }));
      hitsByType.set(nodeType, arr);
    }

    // Attach Global PageRank.
    const allEdges = db
      .prepare("SELECT from_id, to_id, edge_type, attribution FROM edges")
      .all() as { from_id: string; to_id: string; edge_type: string; attribution: string }[];
    const gpr = globalPageRank(
      allEdges.map((e) => ({
        from: e.from_id,
        to: e.to_id,
        edge_type: e.edge_type,
        attribution: e.attribution as "explicit" | "doco-auto",
      })),
      { alpha: 0.85 },
    );
    const gprById = new Map<string, number>();
    for (const p of gpr) gprById.set(p.id, p.score);

    // Step 4: stitch back in the cosine-descending order.
    const allHits: Hit[] = [];
    for (const arr of hitsByType.values()) {
      for (const h of arr) {
        h.gpr = gprById.get(h.id) ?? 0;
        allHits.push(h);
      }
    }
    allHits.sort((a, b) => b.vector_score - a.vector_score);

    // Step 5: pin the load-bearing scopes to the top, regardless of
    // cosine. The Constitution always pins (per ADR-136) — its rules
    // can block any capture, so agents need it in context on every
    // prompt-broad search. Mandatory scopes (those the Constitution
    // names in a `mandatory_scope` rule, per ADR-129) ALSO pin —
    // capture aborts when a node omits them, so agents need to know
    // they exist before drafting. We skip the pins when the caller
    // has narrowed `node_type` to types that exclude `scope` (targeted
    // lookups respect the caller's narrowing).
    const wantsScope =
      filters.nodeType === null || filters.nodeType.includes("scope");
    if (wantsScope) {
      const scopeCols = pickAvailableColumns(db, "scope", [
        "id",
        "name",
        "summary",
        "created_at",
      ]);
      const constRow = db
        .prepare(
          `SELECT ${scopeCols.join(", ")}, raw_json FROM scope WHERE name = 'constitution' LIMIT 1`,
        )
        .get() as
        | {
            id: string;
            name?: string | null;
            summary?: string | null;
            created_at?: string | null;
            raw_json?: string | null;
          }
        | undefined;

      // Constitution first, then any scope it names in a
      // `mandatory_scope` rule. Order matters — `pinScope` prepends,
      // so we apply mandatories before the Constitution to keep the
      // Constitution at position 0 in the final list.
      const pinScope = (row: {
        id: string;
        name?: string | null;
        summary?: string | null;
        created_at?: string | null;
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
            name: row.name ?? null,
            summary: row.summary ?? "",
            lifecycle: null,
            created_at: row.created_at ?? null,
            gpr: gprById.get(row.id) ?? 0,
            vector_score: scoreEntry
              ? Math.round(scoreEntry.score * 10000) / 10000
              : 0,
            file_path: resolveEntityFilePath(
              docoPath(ownerSlug, docoSlug),
              "scope",
              row.id,
            ),
            pinned: true,
          });
        }
      };

      if (constRow) {
        const mandatoryIds: string[] = [];
        if (typeof constRow.raw_json === "string") {
          try {
            const parsed = JSON.parse(constRow.raw_json) as {
              rules?: unknown;
            };
            const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
            for (const r of rules as Record<string, unknown>[]) {
              if (r.kind !== "mandatory_scope") continue;
              // Plural canonical shape; legacy singular `scope_id` accepted
              // until any pre-plural YAML is rewritten.
              if (Array.isArray(r.scope_ids)) {
                for (const sid of r.scope_ids) {
                  if (typeof sid === "string") mandatoryIds.push(sid);
                }
              } else if (typeof r.scope_id === "string") {
                mandatoryIds.push(r.scope_id);
              }
            }
          } catch {
            // Malformed raw_json — skip mandatory pinning.
          }
        }

        if (mandatoryIds.length > 0) {
          const placeholders = mandatoryIds.map(() => "?").join(",");
          const mandatoryRows = db
            .prepare(
              `SELECT ${scopeCols.join(", ")} FROM scope WHERE id IN (${placeholders}) AND id != ?`,
            )
            .all(...mandatoryIds, constRow.id) as {
            id: string;
            name?: string | null;
            summary?: string | null;
            created_at?: string | null;
          }[];
          for (const row of mandatoryRows) pinScope(row);
        }

        pinScope(constRow);
      }
    }

    // Stable subset for ETag — exclude `duration_ms` so timing jitter
    // doesn't bust the cache for an otherwise-identical response.
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
  } finally {
    db.close();
  }
}
