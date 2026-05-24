// BPMN perspective server-side data loader.
//
// The canvas is partitioned into **pools** — one per Intent in the
// Doco. A pool is a bordered horizontal section with its own internal
// structure (milestone band on top, actor lanes in the middle,
// artifacts band on the bottom). Pools stack vertically. An
// "Unassigned" pool catches neurons that don't cite an Intent.
//
// Inside each pool, lane assignment follows the same three-category
// model as before:
//   - Milestone band (top of the pool): States.
//   - Actor lanes (middle): one per Principal who has work in this
//     pool. Action.actor_id / Decision.decided_by / Intent.actors[0]
//     drives the placement. Decisions whose decided_by is a
//     `collaborator_*` id walk through the collaborator → github_login
//     → matching Principal name path; rows that don't resolve land in
//     Unassigned.
//   - Artifacts band (bottom): References, Ideas, plus any Rule/Eval
//     that didn't re-home onto an Action via `gated_by` / `target_ref`.
//
// Intents themselves are *not* rendered as flow nodes — they're pool
// headers. The Intent's prose labels its pool.
//
// Pool selection for multi-intent neurons (Action/Decision/Log can
// list multiple `intent_ids`) uses **PageRank**: the candidate intent
// with the highest score on the doco's synapse graph wins. With no
// focal neuron, this is plain global PageRank; the personalized variant
// (teleport biased to a focal node) is computed client-side from
// `centerId` so the same graph can re-pool around whichever neuron
// the user clicked into.
//
// Shape map (unchanged from prior phases):
//   intent                  → (pool header, no shape)
//   decision                → diamond     (BPMN gateway)
//   action                  → task        (BPMN rounded-rect task)
//   rule                    → rectangle   (policy box)
//   state                   → milestone   (compact labeled box)
//   eval, reference         → document    (BPMN data object)
//   idea                    → rounded     (capsule)
//
// Not rendered: Log (instances, not designs).

import { ALL_ENTITY_TABLES } from "@doco/db";
import { parse as parseYaml } from "yaml";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { highestRanked, pageRank } from "./pagerank";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type BpmnShape =
  | "circle"
  | "diamond"
  | "rectangle"
  | "document"
  | "rounded"
  | "task"
  | "milestone";

export type BpmnLaneKind = "milestone" | "actor" | "artifacts" | "unassigned" | "unresolved";

export interface BpmnPool {
  id: string; // "pool:<intent_id>" or POOL_UNASSIGNED_ID
  intent_id: string | null; // null for the Unassigned pool
  label: string; // Intent prose (first line), or "Unassigned"
  /** Per-neuron PageRank score on the doco's synapse graph; drives
   *  pool ordering and primary-intent picks for multi-intent neurons. */
  pagerank: number;
}

export interface BpmnLane {
  /** Composite id: `${pool_id}::${base}`. Unique across the canvas. */
  id: string;
  pool_id: string;
  /** `principal_<ulid>`, BAND_MILESTONE_BASE, BAND_ARTIFACTS_BASE, or
   *  BAND_UNASSIGNED_BASE / `__unresolved__:<raw-ref>`. The bare base
   *  (without the pool prefix) is recorded for renderer convenience —
   *  e.g. to look up the Principal row for an actor lane. */
  base_id: string;
  label: string;
  kind: BpmnLaneKind;
}

export interface BpmnNode {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href: string | null;
  shape: BpmnShape;
  laneId: string;
  pool_id: string;
  /** When this neuron has multi-valued `intent_ids`, the full list of
   *  candidate intent ids (so the client can recompute the primary
   *  intent under personalized PageRank without re-fetching). */
  intent_ids?: string[];
}

export interface BpmnGraphData {
  pools: BpmnPool[];
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  links: OverviewGraphLink[];
  /** Per-neuron global PageRank score, exposed so the client can
   *  reuse the same graph to compute personalized PageRank from a
   *  focal neuron without re-running queries. */
  global_pagerank?: Record<string, number>;
}

const BPMN_TABLES: { table: string; entityType: string }[] = [
  { table: "decisions", entityType: "decision" },
  { table: "intents", entityType: "intent" },
  { table: "actions", entityType: "action" },
  { table: "rules", entityType: "rule" },
  { table: "evals", entityType: "eval" },
  { table: "reference_entities", entityType: "reference" },
  { table: "states", entityType: "state" },
  { table: "ideas", entityType: "idea" },
];

// Lane id "bases" (the part after the `pool_id::` prefix). The same
// base lives in every pool that uses it; the composite lane id ties
// it to one specific pool.
const BAND_MILESTONE_BASE = "__milestones__";
const BAND_ARTIFACTS_BASE = "__artifacts__";
const BAND_UNASSIGNED_BASE = "__unassigned__";

export const POOL_UNASSIGNED_ID = "pool:unassigned";

// Non-actor neuron types: their pool placement comes from a different
// signal (the host they re-home onto, or the Unassigned pool).
const ARTIFACT_TYPES = new Set(["reference", "eval", "idea", "rule"]);

const SHAPE_BY_TYPE: Record<string, BpmnShape> = {
  state: "milestone",
  decision: "diamond",
  action: "task",
  rule: "rectangle",
  eval: "document",
  reference: "document",
  idea: "rounded",
};

export function shapeForEntityType(entityType: string): BpmnShape {
  return SHAPE_BY_TYPE[entityType] ?? "rectangle";
}

interface NeuronRow {
  id: string;
  entity_type: string;
  summary: string | null;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
}

interface PrincipalRow {
  id: string;
  name: string;
}

interface CollaboratorRow {
  id: string;
  github_login: string | null;
}

interface SynapseRow {
  from_id: string;
  to_id: string;
  synapse_type: string;
}

export async function loadBpmnGraph(
  c: QueryClient,
  docoId: string,
  opts: { handle?: string } = {},
): Promise<BpmnGraphData> {
  const neuronSql = BPMN_TABLES.map((entry) => {
    const tnCol = ALL_ENTITY_TABLES[entry.entityType]?.typeNamedColumn;
    const summarySelect = tnCol ? `split_part(t.${tnCol}, E'\n', 1) AS summary` : "t.summary";
    return `SELECT t.id,
              '${entry.entityType}'::text AS entity_type,
              ${summarySelect},
              COALESCE(t.lifecycle, 'active') AS lifecycle,
              t.created_at::text AS created_at,
              t.data
         FROM ${entry.table} t
        WHERE t.doco_id = $1
          AND COALESCE(t.lifecycle, 'active') <> 'retired'`;
  }).join(" UNION ALL ");

  const [neuronRows, principalRows, collaboratorRows] = await Promise.all([
    c.query<NeuronRow>(neuronSql, [docoId]),
    c.query<PrincipalRow>(
      `SELECT id, name
         FROM principals
        WHERE doco_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'`,
      [docoId],
    ),
    c.query<CollaboratorRow>(
      `SELECT c.id, c.github_login
         FROM collaborators c
         JOIN doco_users du ON du.collaborator_id = c.id
        WHERE du.doco_id = $1
          AND c.github_login IS NOT NULL`,
      [docoId],
    ),
  ]);

  const principalByName = new Map<string, PrincipalRow>();
  const principalById = new Map<string, PrincipalRow>();
  for (const p of principalRows.rows) {
    principalByName.set(p.name.toLowerCase(), p);
    principalById.set(p.id, p);
  }
  const collaboratorById = new Map<string, CollaboratorRow>();
  for (const cr of collaboratorRows.rows) {
    collaboratorById.set(cr.id, cr);
  }

  const allRows = neuronRows.rows;

  // Index of every Intent row by id — Intents define pools (and don't
  // render as flow nodes themselves).
  const intentsById = new Map<string, NeuronRow>();
  for (const row of allRows) {
    if (row.entity_type === "intent") intentsById.set(row.id, row);
  }

  // Load synapses up front: we need them for PageRank below.
  const nodeIdSet = new Set(allRows.map((r) => r.id));
  let links: OverviewGraphLink[] = [];
  if (nodeIdSet.size > 0) {
    const synapseRows = await c.query<SynapseRow>(
      `SELECT from_id, to_id, synapse_type
         FROM synapses
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND to_id   = ANY($2::text[])
        LIMIT 5000`,
      [docoId, Array.from(nodeIdSet)],
    );
    links = synapseRows.rows.map((r) => ({
      source: r.from_id,
      target: r.to_id,
      synapse_type: r.synapse_type,
    }));
  }

  // ── Global PageRank over the synapse graph ────────────────────────
  // Drives:
  //   1. Pool order (most important Intent's pool first).
  //   2. Primary-intent picks for multi-intent neurons.
  // The personalized variant (teleport biased to a focal node) is the
  // client's job — we just expose the raw global scores so it can
  // recompute when the user clicks into a neuron.
  const pr = pageRank(
    allRows.map((r) => ({ id: r.id })),
    links,
  );

  // ── Pool assignment per neuron ────────────────────────────────────
  // 1. Intents themselves are pool headers, not nodes — they live in
  //    their own pool ("pool:<intent_id>").
  // 2. Actor-type neurons (Action / Decision / Log) with an intent_ids
  //    list go in their primary intent's pool (PR-picked).
  // 3. Actor-type neurons with no intent_ids → Unassigned.
  // 4. Non-actor neurons (State / Reference / Idea / Rule / Eval) start
  //    in Unassigned; Rules and Evals get re-homed below if they have
  //    a host neuron whose pool is known.
  const poolByNeuron = new Map<string, string>();
  const intentIdsByNeuron = new Map<string, string[]>();

  for (const row of allRows) {
    if (row.entity_type === "intent") {
      poolByNeuron.set(row.id, `pool:${row.id}`);
      continue;
    }
    const data = row.data ?? {};
    if (
      row.entity_type === "action" ||
      row.entity_type === "decision" ||
      row.entity_type === "log"
    ) {
      const intentIds = toStringArray(data.intent_ids).filter((id) => intentsById.has(id));
      if (intentIds.length > 0) intentIdsByNeuron.set(row.id, intentIds);
      const primary = intentIds.length > 0 ? highestRanked(intentIds, pr) : null;
      poolByNeuron.set(row.id, primary ? `pool:${primary}` : POOL_UNASSIGNED_ID);
    } else {
      poolByNeuron.set(row.id, POOL_UNASSIGNED_ID);
    }
  }

  // Re-home Rules into the pool of any Action whose `gated_by` cites
  // them. First Action wins (cross-pool duplication is a later phase).
  for (const row of allRows) {
    if (row.entity_type !== "action") continue;
    const data = row.data ?? {};
    const gatedBy = toStringArray(data.gated_by);
    if (gatedBy.length === 0) continue;
    const actionPool = poolByNeuron.get(row.id);
    if (!actionPool) continue;
    for (const ruleId of gatedBy) {
      const existing = poolByNeuron.get(ruleId);
      if (existing === POOL_UNASSIGNED_ID && actionPool !== POOL_UNASSIGNED_ID) {
        poolByNeuron.set(ruleId, actionPool);
      }
    }
  }

  // Re-home Evals to their `target_ref`'s pool when the target lives
  // in a real Intent pool (not Unassigned).
  for (const row of allRows) {
    if (row.entity_type !== "eval") continue;
    const targetRef = typeof row.data?.target_ref === "string" ? row.data.target_ref : null;
    if (!targetRef) continue;
    const targetPool = poolByNeuron.get(targetRef);
    if (targetPool && targetPool !== POOL_UNASSIGNED_ID) {
      poolByNeuron.set(row.id, targetPool);
    }
  }

  // ── Lane assignment within each pool ──────────────────────────────
  // A lane id is composite: `${pool_id}::${base}` — alice in pool 1
  // and alice in pool 2 are different lanes with the same `base_id`
  // (`principal_alice`) but different pool_id. The renderer keys off
  // `id` and walks `pool_id` to group.
  const lanesById = new Map<string, BpmnLane>();
  const nodes: BpmnNode[] = [];

  for (const row of allRows) {
    if (row.entity_type === "intent") continue; // pool header, not a node
    const poolId = poolByNeuron.get(row.id) ?? POOL_UNASSIGNED_ID;
    const data = row.data ?? {};

    let baseId: string;
    let kind: BpmnLaneKind;
    let label: string;

    if (row.entity_type === "state") {
      baseId = BAND_MILESTONE_BASE;
      kind = "milestone";
      label = "Milestones";
    } else if (ARTIFACT_TYPES.has(row.entity_type)) {
      // A Rule or Eval that re-homed onto an actor-type host
      // (Action.gated_by / Eval.target_ref) lands in the host's
      // *actor* lane, not the artifacts band. Others stay in artifacts.
      const hostLane = resolveRehomeHostLane(
        row,
        allRows,
        principalById,
        principalByName,
        collaboratorById,
      );
      if (hostLane) {
        baseId = hostLane.id;
        kind = hostLane.id.startsWith("principal_") ? "actor" : "unresolved";
        label = hostLane.label;
      } else {
        baseId = BAND_ARTIFACTS_BASE;
        kind = "artifacts";
        label = "Artifacts";
      }
    } else {
      // Action / Decision / Log: actor lane.
      const ref = laneReferenceFor(row.entity_type, data, collaboratorById);
      const resolved = resolveLane(ref, principalById, principalByName);
      baseId = resolved.id;
      kind = resolved.id.startsWith("principal_")
        ? "actor"
        : resolved.id === BAND_UNASSIGNED_BASE
          ? "unassigned"
          : "unresolved";
      label = resolved.label;
    }

    const laneId = `${poolId}::${baseId}`;
    if (!lanesById.has(laneId)) {
      lanesById.set(laneId, { id: laneId, pool_id: poolId, base_id: baseId, label, kind });
    }

    const node: BpmnNode = {
      id: row.id,
      entity_type: row.entity_type,
      name: row.summary,
      lifecycle: row.lifecycle,
      created_at: row.created_at,
      href: opts.handle ? `/${opts.handle}/${row.entity_type}/${row.id}` : null,
      shape: shapeForEntityType(row.entity_type),
      laneId,
      pool_id: poolId,
    };
    const intentIds = intentIdsByNeuron.get(row.id);
    if (intentIds && intentIds.length > 0) node.intent_ids = intentIds;
    nodes.push(node);
  }

  // ── Build pools[] ─────────────────────────────────────────────────
  const pools: BpmnPool[] = [];
  const usedPoolIds = new Set<string>();
  for (const id of poolByNeuron.values()) usedPoolIds.add(id);
  for (const intentId of intentsById.keys()) usedPoolIds.add(`pool:${intentId}`);

  for (const id of usedPoolIds) {
    if (id === POOL_UNASSIGNED_ID) {
      pools.push({
        id: POOL_UNASSIGNED_ID,
        intent_id: null,
        label: "Unassigned",
        pagerank: 0,
      });
      continue;
    }
    const intentId = id.startsWith("pool:") ? id.slice("pool:".length) : null;
    if (!intentId) continue;
    const intentRow = intentsById.get(intentId);
    const label = intentRow?.summary?.trim() || "(unnamed intent)";
    pools.push({
      id,
      intent_id: intentId,
      label,
      pagerank: pr.get(intentId) ?? 0,
    });
  }

  // Pool order: real Intent pools sorted by descending PageRank (most
  // important process first), Unassigned pinned to the bottom.
  pools.sort((a, b) => {
    if (a.id === POOL_UNASSIGNED_ID) return 1;
    if (b.id === POOL_UNASSIGNED_ID) return -1;
    return b.pagerank - a.pagerank;
  });

  // Drop pools with no neurons assigned (a freshly-captured Intent
  // gets a pool the moment any Action/Decision serves it; an Intent
  // with zero serving neurons would otherwise show an empty pool).
  // EXCEPTION: we keep an Intent's pool even when empty IF the
  // intent_id is in usedPoolIds via the intentsById loop above —
  // that's deliberately how authors see "I have a goal but no work
  // serving it yet." So no additional filter here; the pools[] array
  // already only contains pools we want to display.

  // Within each pool, ensure principal lanes for every Principal who
  // owns at least one node in that pool (already added above as nodes
  // were emitted). We don't pre-populate empty principal lanes — at
  // pool granularity that would be visually noisy.

  const lanes = Array.from(lanesById.values());

  // Lane order within a pool (the renderer will group by pool_id):
  //   1. Milestone band
  //   2. Actor lanes (principals, alphabetical by label)
  //   3. Unresolved lanes (per-ref __unresolved__:* leaves)
  //   4. Artifacts band
  //   5. Unassigned catchall
  // Sorting the flat list here lets the renderer iterate in display
  // order without needing to re-sort per pool.
  const KIND_ORDER: Record<BpmnLaneKind, number> = {
    milestone: 0,
    actor: 1,
    unresolved: 2,
    artifacts: 3,
    unassigned: 4,
  };
  lanes.sort((a, b) => {
    if (a.pool_id !== b.pool_id) return 0; // grouping is the renderer's job
    const orderDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (orderDiff !== 0) return orderDiff;
    return a.label.localeCompare(b.label);
  });

  // Expose per-neuron PageRank scores so the client can compute
  // personalized PageRank from a focal neuron without re-running the
  // synapse query.
  const globalPagerank: Record<string, number> = {};
  for (const [id, score] of pr) globalPagerank[id] = score;

  return { pools, lanes, nodes, links, global_pagerank: globalPagerank };
}

function parseRawYaml(rawYaml: string | null): Record<string, unknown> {
  if (!rawYaml) return {};
  try {
    const parsed = parseYaml(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return {};
}

function laneReferenceFor(
  entityType: string,
  data: Record<string, unknown>,
  collaboratorById: Map<string, CollaboratorRow>,
): string | null {
  switch (entityType) {
    case "action":
    case "log":
      return firstString(data.actor_id) ?? firstString(data.actor);
    case "decision": {
      const ref = firstString(data.decided_by);
      if (!ref) return null;
      if (ref.startsWith("collaborator_")) {
        const collab = collaboratorById.get(ref);
        return collab?.github_login ?? null;
      }
      return ref;
    }
    case "intent":
      return firstString(data.actors) ?? firstString(data.wanted_by);
    default:
      return null;
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item) return item;
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}

function resolveLane(
  ref: string | null,
  byId: Map<string, PrincipalRow>,
  byName: Map<string, PrincipalRow>,
): { id: string; label: string } {
  if (!ref) return { id: BAND_UNASSIGNED_BASE, label: "Unassigned" };
  const byIdMatch = byId.get(ref);
  if (byIdMatch) return { id: byIdMatch.id, label: byIdMatch.name };
  const cleaned = ref.replace(/^principal_/, "").toLowerCase();
  const byNameMatch = byName.get(cleaned);
  if (byNameMatch) return { id: byNameMatch.id, label: byNameMatch.name };
  return { id: `__unresolved__:${ref}`, label: ref };
}

/**
 * Find the actor lane base for a Rule (via any Action's `gated_by`)
 * or Eval (via `target_ref`) — used to relocate the artifact onto its
 * host's lane instead of the artifacts band. Returns null when no
 * host with a resolved actor lane exists.
 */
function resolveRehomeHostLane(
  row: NeuronRow,
  allRows: NeuronRow[],
  principalById: Map<string, PrincipalRow>,
  principalByName: Map<string, PrincipalRow>,
  collaboratorById: Map<string, CollaboratorRow>,
): { id: string; label: string } | null {
  if (row.entity_type === "rule") {
    for (const candidate of allRows) {
      if (candidate.entity_type !== "action") continue;
      const gatedBy = toStringArray(candidate.data?.gated_by);
      if (!gatedBy.includes(row.id)) continue;
      const ref = laneReferenceFor("action", candidate.data ?? {}, collaboratorById);
      const resolved = resolveLane(ref, principalById, principalByName);
      if (resolved.id.startsWith("principal_")) return resolved;
      return null;
    }
    return null;
  }
  if (row.entity_type === "eval") {
    const targetRef = typeof row.data?.target_ref === "string" ? row.data.target_ref : null;
    if (!targetRef) return null;
    const target = allRows.find((r) => r.id === targetRef);
    if (!target) return null;
    const ref = laneReferenceFor(target.entity_type, target.data ?? {}, collaboratorById);
    const resolved = resolveLane(ref, principalById, principalByName);
    if (resolved.id.startsWith("principal_")) return resolved;
    return null;
  }
  return null;
}
