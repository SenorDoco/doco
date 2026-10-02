// The Doco brief engine: one embedding call and a handful of indexed
// statements across every Doco the caller can read, then the pure tiering,
// fusion and budget fill in ./brief. Seeds come from four mechanisms (nearest
// embeddings, full text, exact touches on what the agent names, glossary
// terms in the ask), grow one hop along edges, and are ordered by reciprocal
// rank fusion with PageRank and recency as tie-breaks. A cross-encoder
// reranker and a one-paragraph synthesis are on by default and switchable per
// request; both are injectable, so tests stub them and keep the database real.

import { type SemanticQuery, rankEmbeddings } from "@doco/db";
import { type Reranker, getDefaultReranker, globalPageRank, rerankItems } from "@doco/index";
import { generateUlid } from "@doco/shared";
import { queryPolicyArticles } from "../agent-bootstrap.server";
import { createSenorDocoMessage, getSenorDocoAnthropicApiKey } from "../assistant-runtime.server";
import { embedQuery } from "../embedding-provider.server";
import { fuseRankings } from "../rank-fusion";
import {
  BRIEF_TIERS,
  type Brief,
  type BriefItem,
  type BriefTier,
  type Candidate,
  DEFAULT_BRIEF_BUDGET,
  IN_MOTION_DAYS,
  STANDING_RULES_MAX,
  SYNTHESIS_ITEMS,
  type Signal,
  type Touch,
  becauseOf,
  expandedText,
  fillBudget,
  parseTouching,
  summaryOf,
  synthesisPrompt,
  tierOf,
  tokensOf,
} from "./brief";

export type BriefClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface BriefScope {
  /** The Docos the caller may read; the brief never looks outside them. */
  docoIds: string[];
  /** Site origin for item links, e.g. https://doco.to. */
  origin: string;
}

export interface BriefRequest {
  about: string;
  touching?: string[];
  budget?: number;
  /** ISO time: start of the "in motion" window (default: the last 7 days). */
  since?: string | null;
  /** Doco id or handle the agent will write to: its goal and policies bind. */
  target?: string | null;
  rerank?: boolean;
  synthesize?: boolean;
  /** Node ids left out of the brief and its hops: the evaluation hides the
   *  record a query is drawn from, so it cannot answer itself. */
  exclude?: string[];
}

export interface SynthesisInput {
  about: string;
  items: Omit<BriefItem, "detail">[];
}

export interface BriefDeps {
  embed?: typeof embedQuery;
  /** undefined: the environment's reranker; null: none. */
  reranker?: Reranker | null;
  /** undefined: the model when a key is configured; null: none. */
  synthesize?: ((input: SynthesisInput) => Promise<string | null>) | null;
  now?: () => Date;
}

/** Candidates the four seed mechanisms may return, before the hop. */
const SEED_LIMIT = 100;
/** Seeds whose neighbours are added, and neighbours per seed. */
const HOP_SEEDS = 40;
const HOP_PER_SEED = 5;
const HOP_LIMIT = 150;
/** Items the reranker reads in one call. */
const RERANK_TOP = 50;
/** Mirror chunks (Slack, Notion) that join the background. */
const MIRROR_LIMIT = 10;
/** Glossary terms that may join the background. */
const TERM_LIMIT = 8;

export const BRIEF_SYNTHESIS_MODEL = "claude-haiku-4-5-20251001";

const SYNTHESIS_SYSTEM = [
  "You open a brief for an AI agent that is about to act in a software project.",
  "From the items given, write one paragraph of at most 120 words saying what the agent must know before it acts: the rules that bind it, the decisions already made, and what is in motion that it could collide with.",
  "Use only the items given. Cite each item you draw on by its id in square brackets. No preamble, no headings, no advice beyond the items.",
].join(" ");

interface DocoRow {
  id: string;
  handle: string;
  workspace_id: string;
  template: string | null;
  goal: string;
}

interface NodeRow {
  id: string;
  doco_id: string;
  node_type: string;
  lifecycle: string;
  prose: string;
  locator: string | null;
  updated_at: string;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
}

/** Compose the brief for one request. Every statement runs on `c`. */
export async function composeBrief(
  c: BriefClient,
  scope: BriefScope,
  request: BriefRequest,
  deps: BriefDeps = {},
): Promise<Brief> {
  const started = Date.now();
  const steps: Record<string, number> = {};
  const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await work();
    } finally {
      steps[step] = Date.now() - t0;
    }
  };
  const warnings: string[] = [];
  const gaps: string[] = [];
  const now = deps.now ? deps.now() : new Date();
  const about = request.about.trim();
  // What the ask itself names counts as touched when nothing else is said to
  // be: the hook sends a prompt and nothing more.
  const touching =
    request.touching?.length || !about
      ? (request.touching ?? [])
      : (
          await c.query<{ value: string }>(
            "SELECT value FROM node_touches_of($1, NULL) ORDER BY kind, value",
            [about],
          )
        ).rows.map((row) => row.value);
  const touches = parseTouching(touching);
  const budget =
    typeof request.budget === "number" && request.budget > 0
      ? Math.floor(request.budget)
      : DEFAULT_BRIEF_BUDGET;
  let sinceMs = now.getTime() - IN_MOTION_DAYS * 86_400_000;
  if (request.since) {
    const parsed = Date.parse(request.since);
    if (Number.isNaN(parsed)) warnings.push(`Ignored since=${request.since}: not a date.`);
    else sinceMs = parsed;
  }

  const brief: Brief = {
    brief_id: `brief_${generateUlid(now.getTime())}`,
    about,
    touching,
    synthesis: null,
    items: [],
    gaps,
    held_back: 0,
    budget,
    tokens_used: 0,
    steps,
    warnings,
  };

  const docos = await loadDocos(c, scope.docoIds);
  const docoIds = docos.map((d) => d.id);
  if (docoIds.length === 0) {
    gaps.push("You can read no Doco; nothing to brief from.");
    steps.total = Date.now() - started;
    return brief;
  }
  if (!about && touches.length === 0) {
    gaps.push("Say what you are about to do (about) or what you touch (touching).");
  }
  const handleOf = new Map(docos.map((d) => [d.id, d.handle]));
  const nodeUrl = (row: NodeRow): string =>
    `${scope.origin}/${handleOf.get(row.doco_id)}/${row.node_type}/${row.id}`;

  // ── Seeds ───────────────────────────────────────────────────────────────
  const semantic = about
    ? await timed("embed", async () => {
        const { semantic, warning } = await (deps.embed ?? embedQuery)(about);
        if (warning) warnings.push(warning);
        return semantic;
      })
    : null;

  const candidates = new Map<string, Candidate>();
  const nodeIds = new Set<string>();
  const signal = (id: string, s: Signal) => {
    const existing = candidates.get(id);
    if (existing) existing.signals.push(s);
    else {
      nodeIds.add(id);
      candidates.set(id, {
        id,
        doco: null,
        type: "",
        lifecycle: null,
        text: "",
        url: null,
        updated_at: null,
        signals: [s],
      });
    }
  };

  const vectorIds: string[] = [];
  const ftsIds: string[] = [];
  const touchIds: string[] = [];
  const termIds: string[] = [];
  const touchHits = new Map<string, Set<string>>();
  const mirrorItems: Omit<BriefItem, "detail">[] = [];

  await timed("seeds", async () => {
    await Promise.all([
      (async () => {
        if (!semantic) return;
        const hits = await rankEmbeddings(c, {
          docoIds,
          source: "node",
          modelId: semantic.modelId,
          queryEmbedding: semantic.queryEmbedding,
          limit: SEED_LIMIT,
        });
        hits.forEach((hit, rank) => {
          vectorIds.push(hit.entity_id);
          signal(hit.entity_id, { kind: "vector", rank });
        });
      })(),
      (async () => {
        if (!about) return;
        // Any of the ask's words, ranked by how many and how densely they
        // match: an ask is a sentence, and demanding every word (the AND that
        // websearch_to_tsquery builds) would miss the decision that shares
        // two of them.
        const rows = (
          await c.query<{ entity_id: string }>(
            `WITH query AS (
               SELECT to_tsquery('english', replace(plainto_tsquery('english', $2)::text, '&', '|')) AS q)
             SELECT f.entity_id
               FROM entity_fts_nodes f CROSS JOIN query
              WHERE f.doco_id = ANY($1::text[]) AND f.search_tsv @@ query.q
              ORDER BY ts_rank_cd(f.search_tsv, query.q) DESC, f.entity_id
              LIMIT $3`,
            [docoIds, about, SEED_LIMIT],
          )
        ).rows;
        rows.forEach((row, rank) => {
          ftsIds.push(row.entity_id);
          signal(row.entity_id, { kind: "fts", rank });
        });
      })(),
      (async () => {
        if (touches.length === 0) return;
        const of = (kind: Touch["kind"]) =>
          touches.filter((t) => t.kind === kind).map((t) => t.value);
        const rows = (
          await c.query<{ node_id: string; kind: string; value: string }>(
            `SELECT t.node_id, t.kind, t.value
               FROM node_touches t
              WHERE t.doco_id = ANY($1::text[])
                AND ((t.kind = 'path' AND EXISTS (
                        SELECT 1 FROM unnest($2::text[]) AS p
                         WHERE t.value = p
                            OR right(t.value, length(p) + 1) = '/' || p
                            OR right(p, length(t.value) + 1) = '/' || t.value))
                  OR (t.kind = 'url' AND t.value = ANY($3::text[]))
                  OR (t.kind = 'node' AND t.value = ANY($4::text[]))
                  OR (t.kind = 'pr' AND t.value = ANY($5::text[])))`,
            [docoIds, of("path"), of("url"), of("node"), of("pr")],
          )
        ).rows;
        for (const row of rows) {
          const hits = touchHits.get(row.node_id) ?? new Set<string>();
          if (hits.has(row.value)) continue;
          hits.add(row.value);
          touchHits.set(row.node_id, hits);
          signal(row.node_id, { kind: "touch", value: row.value });
        }
        for (const id of of("node")) signal(id, { kind: "named" });
      })(),
      (async () => {
        if (!about) return;
        const glossaryIds = docos.filter((d) => d.template === "glossary").map((d) => d.id);
        if (glossaryIds.length === 0) return;
        const rows = (
          await c.query<{ id: string; prose: string }>(
            `SELECT id, prose FROM nodes
              WHERE doco_id = ANY($1::text[]) AND node_type <> 'principal'
                AND lifecycle <> 'retired'`,
            [glossaryIds],
          )
        ).rows;
        const matched = rows
          .map((row) => ({ id: row.id, term: summaryOf(row.prose) }))
          .filter(({ term }) => term && termPattern(term).test(about))
          .sort((a, b) => b.term.length - a.term.length)
          .slice(0, TERM_LIMIT);
        for (const { id, term } of matched) {
          termIds.push(id);
          signal(id, { kind: "term", term });
        }
      })(),
      (async () => {
        if (!semantic) return;
        for (const source of ["slack", "notion"] as const) {
          const hits = await rankEmbeddings(c, {
            docoIds,
            source,
            modelId: semantic.modelId,
            queryEmbedding: semantic.queryEmbedding,
            limit: MIRROR_LIMIT,
          });
          for (const hit of hits) {
            mirrorItems.push({
              id: hit.entity_id,
              tier: "background",
              type: source,
              doco: handleOf.get(hit.doco_id) ?? null,
              lifecycle: null,
              summary: summaryOf(hit.chunk_text),
              text: expandedText(hit.chunk_text),
              because: `matches your ask (${source === "slack" ? "Slack" : "Notion"} mirror)`,
              url: null,
              updated_at: null,
            });
          }
        }
      })(),
      (async () => {
        const total = (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM nodes
              WHERE doco_id = ANY($1::text[]) AND node_type = 'rule' AND lifecycle = 'active'`,
            [docoIds],
          )
        ).rows[0]?.n;
        if (total === 0) gaps.push("No active rules in the Docos you can read.");
        if (!total || total > STANDING_RULES_MAX) return;
        const rows = (
          await c.query<{ id: string }>(
            `SELECT id FROM nodes
              WHERE doco_id = ANY($1::text[]) AND node_type = 'rule' AND lifecycle = 'active'
              ORDER BY created_at, id`,
            [docoIds],
          )
        ).rows;
        for (const row of rows) signal(row.id, { kind: "standing" });
      })(),
    ]);
  });
  for (const id of request.exclude ?? []) {
    candidates.delete(id);
    nodeIds.delete(id);
  }
  touchIds.push(...touchHits.keys());
  touchIds.sort(
    (a, b) => (touchHits.get(b)?.size ?? 0) - (touchHits.get(a)?.size ?? 0) || a.localeCompare(b),
  );

  // ── One hop, replacements, hydration ────────────────────────────────────
  const hopIds: string[] = [];
  const nodes = new Map<string, NodeRow>();
  await timed("expand", async () => {
    const seedOrder = fuseRankings([vectorIds, ftsIds, touchIds]).filter((id) =>
      candidates.has(id),
    );
    const hopFrom = seedOrder.slice(0, HOP_SEEDS);
    let rows = await loadNodes(c, [...nodeIds], docoIds);
    for (const row of rows) nodes.set(row.id, row);

    // A retired seed points at what replaced it: the replacement joins, the
    // retired node is left out by the tiering.
    const retired = [...nodes.values()].filter((n) => n.lifecycle === "retired").map((n) => n.id);
    if (retired.length > 0) {
      const edges = (
        await c.query<EdgeRow>(
          `SELECT from_id, to_id, edge_type FROM edges
            WHERE doco_id = ANY($1::text[]) AND edge_type = 'replaces'
              AND lifecycle <> 'retired' AND to_id = ANY($2::text[])`,
          [docoIds, retired],
        )
      ).rows;
      for (const edge of edges) signal(edge.from_id, { kind: "replaces", old: edge.to_id });
    }

    if (hopFrom.length > 0) {
      const edges = (
        await c.query<EdgeRow>(
          `SELECT from_id, to_id, edge_type FROM edges
            WHERE doco_id = ANY($1::text[]) AND lifecycle <> 'retired'
              AND (from_id = ANY($2::text[]) OR to_id = ANY($2::text[]))`,
          [docoIds, hopFrom],
        )
      ).rows;
      const hopped = new Set<string>();
      for (const seed of hopFrom) {
        let n = 0;
        for (const edge of edges) {
          if (n >= HOP_PER_SEED || hopIds.length >= HOP_LIMIT) break;
          const seedIsFrom = edge.from_id === seed;
          if (!seedIsFrom && edge.to_id !== seed) continue;
          const other = seedIsFrom ? edge.to_id : edge.from_id;
          // A seed is not a neighbour; a node two seeds reach keeps both hops.
          if (candidates.has(other) && !hopped.has(other)) continue;
          n++;
          if (!hopped.has(other)) {
            hopped.add(other);
            hopIds.push(other);
          }
          signal(other, {
            kind: "hop",
            edge_type: edge.edge_type,
            via: seed,
            // Seen from the neighbour: the seed's outgoing edge comes in to it.
            direction: seedIsFrom ? "in" : "out",
          });
        }
      }
    }
    const missing = [...nodeIds].filter((id) => !nodes.has(id));
    rows = await loadNodes(c, missing, docoIds);
    for (const row of rows) nodes.set(row.id, row);
  });

  // Standing orders bind where the agent works: the target Doco's workspace
  // and the workspaces its matches come from; when nothing matched, every
  // workspace it reads. A rule standing in another workspace is left out.
  const workspaceOf = new Map(docos.map((d) => [d.id, d.workspace_id]));
  const target = request.target
    ? docos.find((d) => d.id === request.target || d.handle === request.target)
    : undefined;
  const working = new Set<string>();
  if (target) working.add(target.workspace_id);
  for (const [id, candidate] of candidates) {
    const row = nodes.get(id);
    if (!row) {
      candidates.delete(id);
      continue;
    }
    candidate.doco = handleOf.get(row.doco_id) ?? null;
    candidate.type = row.node_type;
    candidate.lifecycle = row.lifecycle;
    candidate.text = row.prose;
    candidate.updated_at = new Date(row.updated_at).toISOString();
    candidate.url = row.locator && /^https?:\/\//.test(row.locator) ? row.locator : nodeUrl(row);
    if (candidate.signals.some((s) => s.kind !== "standing"))
      working.add(workspaceOf.get(row.doco_id) as string);
  }
  if (working.size === 0) for (const d of docos) working.add(d.workspace_id);
  for (const [id, candidate] of candidates) {
    const workspace = workspaceOf.get(nodes.get(id)?.doco_id ?? "") as string;
    if (candidate.signals.every((s) => s.kind === "standing") && !working.has(workspace))
      candidates.delete(id);
  }

  // ── Rank ────────────────────────────────────────────────────────────────
  const ordered = await timed("rank", async () => {
    const edges = (
      await c.query<EdgeRow>(
        `SELECT from_id, to_id, edge_type FROM edges
          WHERE doco_id = ANY($1::text[]) AND lifecycle <> 'retired'`,
        [docoIds],
      )
    ).rows;
    const gpr = new Map(
      globalPageRank(
        edges.map((e) => ({ from: e.from_id, to: e.to_id, edge_type: e.edge_type })),
        { alpha: 0.85, directed: true },
      ).map((p) => [p.id, p.score]),
    );
    const ids = [...candidates.keys()];
    const byRank = [...ids].sort((a, b) => (gpr.get(b) ?? 0) - (gpr.get(a) ?? 0));
    const byRecency = [...ids].sort(
      (a, b) =>
        Date.parse(candidates.get(b)?.updated_at ?? "") -
        Date.parse(candidates.get(a)?.updated_at ?? ""),
    );
    const named = ids.filter((id) => candidates.get(id)?.signals.some((s) => s.kind === "named"));
    // Matches lead; a hop is three quarters of a match; authority (PageRank)
    // and recency list every candidate, so they only break ties.
    return fuseRankings(
      [named, touchIds, vectorIds, ftsIds, termIds, hopIds, byRank, byRecency],
      undefined,
      [1, 1, 1, 1, 1, 0.75, 0.25, 0.25],
    ).filter((id) => candidates.has(id));
  });

  const ctx = { sinceMs };
  const tiered: Omit<BriefItem, "detail">[] = [];
  const item = (
    candidate: Candidate,
    tier: BriefTier,
    because = becauseOf(candidate),
  ): Omit<BriefItem, "detail"> => ({
    id: candidate.id,
    tier,
    type: candidate.type,
    doco: candidate.doco,
    lifecycle: candidate.lifecycle,
    summary: summaryOf(candidate.text),
    text: expandedText(candidate.text),
    because,
    url: candidate.url,
    updated_at: candidate.updated_at,
  });

  // Standing orders lead the first tier: the constitution, the target Doco's
  // goal and policies, then the rules, then the decisions that bind.
  const workspaces = await loadConstitutions(c, [...working]);
  for (const w of workspaces) {
    if (!w.constitution.trim()) {
      gaps.push(`Workspace ${w.name} has no constitution.`);
      continue;
    }
    tiered.push({
      id: w.id,
      tier: "must_obey",
      type: "constitution",
      doco: null,
      lifecycle: null,
      summary: `Constitution of ${w.name}`,
      text: expandedText(w.constitution),
      because: "the workspace's charter",
      url: `${scope.origin}/workspaces/${w.handle}`,
      updated_at: null,
    });
  }
  if (request.target) {
    if (!target) gaps.push(`Target Doco ${request.target} is not one you can read.`);
    else {
      if (target.goal.trim()) {
        tiered.push({
          id: target.id,
          tier: "must_obey",
          type: "doco",
          doco: target.handle,
          lifecycle: null,
          summary: `What ${target.handle} is for`,
          text: expandedText(target.goal),
          because: "where you will write",
          url: `${scope.origin}/${target.handle}`,
          updated_at: null,
        });
      }
      for (const policy of await queryPolicyArticles(c, target.id)) {
        if (!policy.agent_instruction) continue;
        tiered.push({
          id: policy.id,
          tier: "must_obey",
          type: "policy",
          doco: target.handle,
          lifecycle: policy.lifecycle,
          summary: summaryOf(policy.agent_instruction),
          text: expandedText(policy.agent_instruction),
          because: `policy of ${target.handle}, where you will write`,
          url: `${scope.origin}/${target.handle}/policies`,
          updated_at: null,
        });
      }
    }
  }
  const tierOfId = new Map<string, BriefTier>();
  for (const id of ordered) {
    const candidate = candidates.get(id);
    if (!candidate) continue;
    const tier = tierOf(candidate, ctx);
    if (tier) tierOfId.set(id, tier);
  }
  const firstTier = ordered.filter((id) => tierOfId.get(id) === "must_obey");
  for (const id of firstTier.filter((id) => candidates.get(id)?.type === "rule"))
    tiered.push(item(candidates.get(id) as Candidate, "must_obey"));
  for (const id of firstTier.filter((id) => candidates.get(id)?.type !== "rule"))
    tiered.push(item(candidates.get(id) as Candidate, "must_obey"));
  let rest: Omit<BriefItem, "detail">[] = [];
  for (const tier of BRIEF_TIERS) {
    if (tier === "must_obey") continue;
    for (const id of ordered) {
      if (tierOfId.get(id) === tier) rest.push(item(candidates.get(id) as Candidate, tier));
    }
    if (tier === "background") rest.push(...mirrorItems);
  }

  // ── Rerank (on by default) ─────────────────────────────────────────────
  const reranker = deps.reranker === undefined ? getDefaultReranker() : deps.reranker;
  if (request.rerank !== false && about && rest.length > 1) {
    if (!reranker) warnings.push("No reranker is configured; order is by rank fusion alone.");
    else {
      try {
        rest = await timed("rerank", async () => {
          const head = rest.slice(0, RERANK_TOP);
          const scored = await rerankItems(
            reranker,
            about,
            head,
            (it) => `${it.summary}\n${it.text}`,
          );
          const scoreOf = new Map(scored.map(({ item, score }) => [item.id, score]));
          const reranked = [...head].sort(
            (a, b) =>
              (scoreOf.get(b.id) ?? Number.NEGATIVE_INFINITY) -
              (scoreOf.get(a.id) ?? Number.NEGATIVE_INFINITY),
          );
          const all = [...reranked, ...rest.slice(RERANK_TOP)];
          // Tiers hold: the reranker orders within a tier, never across.
          return BRIEF_TIERS.flatMap((tier) => all.filter((it) => it.tier === tier));
        });
      } catch (e) {
        warnings.push(`Reranker failed (${(e as Error).message}); order is by rank fusion.`);
      }
    }
  }
  const all = [...tiered, ...rest];

  // ── Synthesis (on by default) ──────────────────────────────────────────
  const synthesize = deps.synthesize === undefined ? synthesizeWithModel : deps.synthesize;
  if (request.synthesize !== false && synthesize && all.length > 0) {
    try {
      brief.synthesis = await timed("synthesize", () =>
        synthesize({
          about,
          items: all.filter((it) => it.tier !== "background").slice(0, SYNTHESIS_ITEMS),
        }),
      );
      if (brief.synthesis === null) warnings.push("No model is configured for the synthesis.");
    } catch (e) {
      warnings.push(`Synthesis failed (${(e as Error).message}).`);
    }
  }

  // ── Gaps and budget ────────────────────────────────────────────────────
  for (const touch of touches) {
    const found = [...candidates.values()].some((cand) =>
      cand.signals.some(
        (s) =>
          (s.kind === "touch" && touchMatches(touch, s.value)) ||
          (s.kind === "named" && cand.id === touch.value),
      ),
    );
    if (!found) gaps.push(`Nothing in Doco names ${touch.value}.`);
  }
  if (touches.length > 0 && !all.some((it) => it.type === "decision" && /names /.test(it.because)))
    gaps.push("No decision mentions what you touch.");

  const reserved = tokensOf(brief.synthesis ?? "") + 40;
  const filled = fillBudget(all, budget, reserved);
  brief.items = filled.served;
  brief.held_back = filled.held_back;
  brief.tokens_used = filled.tokens_used;
  steps.total = Date.now() - started;
  return brief;
}

/** The paragraph a model writes over the first three tiers. */
export async function synthesizeWithModel(input: SynthesisInput): Promise<string | null> {
  if (!getSenorDocoAnthropicApiKey()) return null;
  const message = await createSenorDocoMessage({
    model: BRIEF_SYNTHESIS_MODEL,
    max_tokens: 240,
    system: SYNTHESIS_SYSTEM,
    messages: [{ role: "user", content: synthesisPrompt(input.about, input.items) }],
  });
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return text || null;
}

async function loadDocos(c: BriefClient, docoIds: string[]): Promise<DocoRow[]> {
  if (docoIds.length === 0) return [];
  return (
    await c.query<DocoRow>(
      `SELECT id, handle, workspace_id, data->>'template_handle' AS template, goal
         FROM docos WHERE id = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY handle`,
      [docoIds],
    )
  ).rows;
}

async function loadNodes(c: BriefClient, ids: string[], docoIds: string[]): Promise<NodeRow[]> {
  if (ids.length === 0) return [];
  return (
    await c.query<NodeRow>(
      `SELECT id, doco_id, node_type, lifecycle, prose, locator, updated_at
         FROM nodes WHERE id = ANY($1::text[]) AND doco_id = ANY($2::text[])`,
      [ids, docoIds],
    )
  ).rows;
}

async function loadConstitutions(
  c: BriefClient,
  workspaceIds: string[],
): Promise<{ id: string; handle: string; name: string; constitution: string }[]> {
  return (
    await c.query<{ id: string; handle: string; name: string; constitution: string }>(
      `SELECT w.id, w.handle, w.name, w.constitution FROM workspaces w
        WHERE w.id = ANY($1::text[]) ORDER BY w.handle`,
      [workspaceIds],
    )
  ).rows;
}

function termPattern(term: string): RegExp {
  return new RegExp(
    `(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`,
    "i",
  );
}

/** Whether a stored touch value is the touched thing (paths match by suffix). */
function touchMatches(touch: Touch, value: string): boolean {
  if (touch.kind !== "path") return value === touch.value;
  return (
    value === touch.value || value.endsWith(`/${touch.value}`) || touch.value.endsWith(`/${value}`)
  );
}
