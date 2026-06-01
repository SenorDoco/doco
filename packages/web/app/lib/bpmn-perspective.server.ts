// BPMN perspective server-side data loader.
//
// The canvas is partitioned into **pools** — one per Intent in the
// Doco. A pool is a bordered horizontal section with its own internal
// structure (milestone band on top, actor lanes in the middle,
// artifacts band on the bottom). Pools stack vertically. An
// "Unassigned" pool catches nodes that don't cite an Intent.
//
// Inside each pool, lane assignment follows the same three-category
// model as before:
//   - Milestone band (top of the pool): States.
//   - Actor lanes (middle): one per Principal who has work in this
//     pool. Action.actor_id / Decision.decided_by / Intent.actors[0]
//     drives the placement. Decisions whose decided_by is a
//     `user_*` id walk through the user → github_login
//     → matching Principal name path; rows that don't resolve land in
//     Unassigned.
//   - Artifacts band (bottom): References, Ideas, plus any Rule/Eval
//     that didn't re-home onto an Action via `gated_by` / `target_ref`.
//
// Intents themselves are *not* rendered as flow nodes — they're pool
// headers. The Intent's prose labels its pool.
//
// Pool selection for multi-intent flow nodes (Action/Decision/State/Log can
// list multiple `intent_ids`) uses **PageRank**: the candidate intent
// with the highest score on the doco's edge graph wins. With no
// focal node, this is plain global PageRank; the personalized variant
// (teleport biased to a focal node) is computed client-side from
// `centerId` so the same graph can re-pool around whichever node
// the user clicked into.
//
// Shape map:
//   intent                  → (pool header, no shape)
//   decision                → diamond     (BPMN gateway)
//   action                  → task        (BPMN rounded-rect task)
//   rule                    → rectangle   (policy box)
//   state                   → task        (milestone-band task)
//   eval, reference         → document    (BPMN data object)
//   idea                    → rounded     (capsule)
//
// Not rendered: Log (instances, not designs).

import {
  MANAGED_EDGE_TYPES,
  cardinalityForManagedField,
  fieldForManagedEdge,
  stripManagedEdgeProps,
} from "@doco/shared";
import { parse as parseYaml } from "yaml";
import type { OverviewGraphLink } from "~/components/overview-graph";
import { computeForwardSequenceDepths } from "./bpmn-sequence-depth";
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
  /** Per-node PageRank score on the doco's edge graph; drives
   *  pool ordering and primary-intent picks for multi-intent nodes. */
  pagerank: number;
  /** Intent's lifecycle (drafting / proposed / active / retired). Null
   *  for the Unassigned pool. Drives the lifecycle badge on the pool
   *  header. */
  lifecycle: string | null;
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
  /** Underlying entity's lifecycle when the lane represents a node
   *  (actor lanes carry the Principal's lifecycle). Null for bands
   *  and synthetic catch-all lanes — they have no single owning
   *  node. */
  lifecycle: string | null;
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
  /** When this node has multi-valued `intent_ids`, the full list of
   *  candidate intent ids (so the client can recompute the primary
   *  intent under personalized PageRank without re-fetching). */
  intent_ids?: string[];
  /**
   * Server-side sequence-flow depth. The renderer uses this as a floor
   * for horizontal sequence layout so incoming flow targets stay to
   * the right of their source.
   */
  bfs_depth?: number;
}

export interface BpmnGraphData {
  pools: BpmnPool[];
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  links: OverviewGraphLink[];
  /** Per-node global PageRank score, exposed so the client can
   *  reuse the same graph to compute personalized PageRank from a
   *  focal node without re-running queries. */
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

// Non-actor node types: their pool placement comes from a different
// signal (the host they re-home onto, or the Unassigned pool).
const ARTIFACT_TYPES = new Set(["reference", "eval", "idea", "rule"]);
const SHAPE_BY_TYPE: Record<string, BpmnShape> = {
  state: "task", // same glyph as Action — full-sized, readable, not a compact band label
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

interface NodeRow {
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
  lifecycle: string | null;
}

interface UserRow {
  id: string;
  github_login: string | null;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  edge_type: string;
  edge_props_json: Record<string, unknown> | null;
}

export async function loadBpmnGraph(
  c: QueryClient,
  docoId: string,
  opts: { focusId?: string; handle?: string; nodeLimit?: number } = {},
): Promise<BpmnGraphData> {
  // Post-collapse: one `nodes` query over the eight BPMN node types
  // (BPMN_TABLES deliberately excludes logs and principals — principals
  // are loaded separately below as actor lanes). `summary` is the first
  // line of `prose`.
  const bpmnTypeList = BPMN_TABLES.map((entry) => `'${entry.entityType}'`).join(", ");
  const nodeSql = `SELECT t.id,
              t.node_type AS entity_type,
              split_part(t.prose, E'\n', 1) AS summary,
              COALESCE(t.lifecycle, 'asserted') AS lifecycle,
              t.created_at::text AS created_at,
              t.data
         FROM nodes t
        WHERE t.doco_id = $1
          AND t.node_type IN (${bpmnTypeList})
          AND COALESCE(t.lifecycle, 'asserted') <> 'retired'`;

  const [nodeRows, principalRows, userRows] = await Promise.all([
    c.query<NodeRow>(nodeSql, [docoId]),
    c.query<PrincipalRow>(
      `SELECT id, name, COALESCE(lifecycle, 'asserted') AS lifecycle
         FROM nodes
        WHERE node_type = 'principal'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'`,
      [docoId],
    ),
    c.query<UserRow>(
      `SELECT c.id, c.github_login
         FROM users c
         JOIN doco_users du ON du.user_id = c.id
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
  const userById = new Map<string, UserRow>();
  for (const cr of userRows.rows) {
    userById.set(cr.id, cr);
  }

  const allRows = nodeRows.rows;

  // Index of every Intent row by id — Intents define pools (and don't
  // render as flow nodes themselves).
  const intentsById = new Map<string, NodeRow>();
  for (const row of allRows) {
    if (row.entity_type === "intent") intentsById.set(row.id, row);
  }

  // Load edges up front: we need them for PageRank below.
  const nodeIdSet = new Set(allRows.map((r) => r.id));
  let links: OverviewGraphLink[] = [];
  if (nodeIdSet.size > 0) {
    const edgeRows = await c.query<EdgeRow>(
      `SELECT id, from_id, to_id, edge_type, props AS edge_props_json
         FROM edges
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND to_id   = ANY($2::text[])
        LIMIT 5000`,
      [docoId, Array.from(nodeIdSet)],
    );
    links = edgeRows.rows.map((r) => bpmnLinkFromEdgeRow(r, opts.handle));

    // Reconstruct the managed relationship fields (actor_id, decided_by, etc.)
    // onto each node's `data` from first-class edges — they no longer live in
    // stored `data` (option (i)). The PageRank query above keeps only edges
    // whose endpoints are both flow nodes, so it omits attribution edges
    // (which point at principals); fetch them explicitly so the actor lanes
    // resolve.
    const managedRows = await c.query<{
      from_id: string;
      edge_type: string;
      to_id: string;
      props: Record<string, unknown> | null;
    }>(
      `SELECT from_id, edge_type, to_id, props
         FROM edges
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND edge_type = ANY($3::text[])
          AND lifecycle <> 'retired'`,
      [docoId, Array.from(nodeIdSet), MANAGED_EDGE_TYPES],
    );
    const dataById = new Map<string, Record<string, unknown>>(
      allRows.map((r) => [r.id, r.data as Record<string, unknown>]),
    );
    for (const e of managedRows.rows) {
      const field = fieldForManagedEdge(e.edge_type, e.props);
      const data = dataById.get(e.from_id);
      if (!field || !data) continue;
      const cardinality = cardinalityForManagedField(field);
      const props = stripManagedEdgeProps(e.props);
      const value = field === "sequence_to" ? { target: e.to_id, ...props } : e.to_id;
      if (cardinality === "many") {
        const list = Array.isArray(data[field]) ? (data[field] as unknown[]) : [];
        list.push(value);
        data[field] = list;
      } else {
        data[field] = value;
      }
    }
  }

  // ── Global PageRank over the edge graph ────────────────────────
  // Drives:
  //   1. Pool order (most important Intent's pool first).
  //   2. Primary-intent picks for multi-intent nodes.
  // The personalized variant (teleport biased to a focal node) is the
  // client's job — we just expose the raw global scores so it can
  // recompute when the user clicks into a node.
  const pr = pageRank(
    allRows.map((r) => ({ id: r.id })),
    links,
  );

  // ── Pool assignment per node ────────────────────────────────────
  // 1. Intents themselves are pool headers, not nodes — they live in
  //    their own pool ("pool:<intent_id>").
  // 2. Flow nodes (Action / Decision / State / Log) with an intent_ids
  //    list go in their primary intent's pool (PR-picked).
  // 3. Flow nodes with no intent_ids → Unassigned.
  // 4. Non-actor nodes (Reference / Idea / Rule / Eval) start
  //    in Unassigned; Rules and Evals get re-homed below if they have
  //    a host node whose pool is known.
  const poolByNode = new Map<string, string>();
  const intentIdsByNode = new Map<string, string[]>();

  for (const row of allRows) {
    if (row.entity_type === "intent") {
      poolByNode.set(row.id, `pool:${row.id}`);
      continue;
    }
    const data = row.data ?? {};
    if (
      row.entity_type === "action" ||
      row.entity_type === "decision" ||
      row.entity_type === "state" ||
      row.entity_type === "log"
    ) {
      const intentIds = toStringArray(data.intent_ids).filter((id) => intentsById.has(id));
      if (intentIds.length > 0) intentIdsByNode.set(row.id, intentIds);
      const primary = intentIds.length > 0 ? highestRanked(intentIds, pr) : null;
      poolByNode.set(row.id, primary ? `pool:${primary}` : POOL_UNASSIGNED_ID);
    } else {
      poolByNode.set(row.id, POOL_UNASSIGNED_ID);
    }
  }

  // Re-home Rules into the pool of any Action whose `gated_by` cites
  // them. First Action wins (cross-pool duplication is a later phase).
  for (const row of allRows) {
    if (row.entity_type !== "action") continue;
    const data = row.data ?? {};
    const gatedBy = toStringArray(data.gated_by);
    if (gatedBy.length === 0) continue;
    const actionPool = poolByNode.get(row.id);
    if (!actionPool) continue;
    for (const ruleId of gatedBy) {
      const existing = poolByNode.get(ruleId);
      if (existing === POOL_UNASSIGNED_ID && actionPool !== POOL_UNASSIGNED_ID) {
        poolByNode.set(ruleId, actionPool);
      }
    }
  }

  // Re-home Evals to their `target_ref`'s pool when the target lives
  // in a real Intent pool (not Unassigned).
  for (const row of allRows) {
    if (row.entity_type !== "eval") continue;
    const targetRef = typeof row.data?.target_ref === "string" ? row.data.target_ref : null;
    if (!targetRef) continue;
    const targetPool = poolByNode.get(targetRef);
    if (targetPool && targetPool !== POOL_UNASSIGNED_ID) {
      poolByNode.set(row.id, targetPool);
    }
  }

  // ── No-Unassigned-pool policy ─────────────────────────────────────
  // Every node lands in *some* Intent's pool. Direct-host rules above
  // win. Remaining nodes use a single multi-source BFS from all
  // Intents over the edge graph; disconnected nodes fall back to
  // the highest-global-PR Intent. Avoid per-node personalized
  // PageRank here — that multiplied render cost by every homeless
  // node and made medium Docos feel huge.
  if (intentsById.size > 0) {
    const intentIds = Array.from(intentsById.keys());
    const homeless: NodeRow[] = [];
    for (const row of allRows) {
      if (row.entity_type === "intent") continue;
      if (poolByNode.get(row.id) === POOL_UNASSIGNED_ID) homeless.push(row);
    }
    if (homeless.length > 0) {
      const nearestIntentByNode = computeNearestIntentByNode(intentIds, links, pr);
      const defaultIntent = highestRanked(intentIds, pr);
      for (const row of homeless) {
        const bestIntent = nearestIntentByNode.get(row.id) ?? defaultIntent;
        if (bestIntent) poolByNode.set(row.id, `pool:${bestIntent}`);
      }
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
    const poolId = poolByNode.get(row.id) ?? POOL_UNASSIGNED_ID;
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
        userById,
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
      const ref = laneReferenceFor(row.entity_type, data, userById);
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
      // Actor lanes carry the Principal's lifecycle so the lane header
      // can render the same type/lifecycle badge stack a node does.
      // Bands and synthetic catch-alls have no owning node — null.
      const laneLifecycle: string | null =
        kind === "actor" ? (principalById.get(baseId)?.lifecycle ?? null) : null;
      lanesById.set(laneId, {
        id: laneId,
        pool_id: poolId,
        base_id: baseId,
        label,
        kind,
        lifecycle: laneLifecycle,
      });
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
    const intentIds = intentIdsByNode.get(row.id);
    if (intentIds && intentIds.length > 0) node.intent_ids = intentIds;
    nodes.push(node);
  }

  // ── Forward sequence depth ────────────────────────────────────────
  // BPMN ordering is based on explicit forward sequence flow only.
  // Association edges such as `supports` and `constrained_by`
  // should not move nodes horizontally.
  const sequenceDepthById = computeForwardSequenceDepths(nodes, links);
  for (const node of nodes) {
    const depth = sequenceDepthById.get(node.id);
    if (depth !== undefined && depth > 0) node.bfs_depth = depth;
  }

  // ── Build pools[] ─────────────────────────────────────────────────
  const pools: BpmnPool[] = [];
  const usedPoolIds = new Set<string>();
  for (const id of poolByNode.values()) usedPoolIds.add(id);
  for (const intentId of intentsById.keys()) usedPoolIds.add(`pool:${intentId}`);

  for (const id of usedPoolIds) {
    if (id === POOL_UNASSIGNED_ID) {
      pools.push({
        id: POOL_UNASSIGNED_ID,
        intent_id: null,
        label: "Unassigned",
        pagerank: 0,
        lifecycle: null,
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
      lifecycle: intentRow?.lifecycle ?? null,
    });
  }

  // Pool order: real Intent pools sorted by descending PageRank (most
  // important process first), Unassigned pinned to the bottom.
  pools.sort((a, b) => {
    if (a.id === POOL_UNASSIGNED_ID) return 1;
    if (b.id === POOL_UNASSIGNED_ID) return -1;
    return b.pagerank - a.pagerank;
  });

  // Drop pools with no nodes assigned (a freshly-captured Intent
  // gets a pool the moment any Action/Decision serves it; an Intent
  // with zero serving nodes would otherwise show an empty pool).
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
  const laneEntryOrder = computeLaneEntryOrder(nodes, links);

  // Lane order within a pool (the renderer will group by pool_id):
  //   1. Milestone band
  //   2. Actor lanes in the order they first enter the flow
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
    if (a.kind === "actor" && b.kind === "actor") {
      const entryDiff = compareLaneEntryOrder(laneEntryOrder.get(a.id), laneEntryOrder.get(b.id));
      if (entryDiff !== 0) return entryDiff;
    }
    return a.label.localeCompare(b.label);
  });

  // Expose per-node PageRank scores so the client can compute
  // personalized PageRank from a focal node without re-running the
  // edge query.
  const globalPagerank: Record<string, number> = {};
  for (const [id, score] of pr) globalPagerank[id] = score;

  return limitBpmnGraph(
    { pools, lanes, nodes, links, global_pagerank: globalPagerank },
    opts.nodeLimit,
    opts.focusId,
  );
}

function limitBpmnGraph(
  graph: BpmnGraphData,
  nodeLimit: number | undefined,
  focusId: string | undefined,
): BpmnGraphData {
  if (!nodeLimit || graph.nodes.length <= nodeLimit) return graph;

  const limit = Math.max(1, Math.floor(nodeLimit));
  const selected = selectBpmnNodeIds(graph.nodes, graph.links, limit, focusId);
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = graph.links.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));
  const laneIds = new Set(nodes.map((node) => node.laneId));
  const poolIds = new Set(nodes.map((node) => node.pool_id));
  const lanes = graph.lanes.filter((lane) => laneIds.has(lane.id));
  const pools = graph.pools.filter((pool) => poolIds.has(pool.id));
  const globalPagerank = Object.fromEntries(
    Object.entries(graph.global_pagerank ?? {}).filter(
      ([id]) => nodeIds.has(id) || poolIds.has(`pool:${id}`),
    ),
  );
  return { pools, lanes, nodes, links, global_pagerank: globalPagerank };
}

function selectBpmnNodeIds(
  nodes: readonly BpmnNode[],
  links: readonly OverviewGraphLink[],
  limit: number,
  focusId: string | undefined,
): Set<string> {
  const selected = new Set<string>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const add = (id: string | null | undefined) => {
    if (!id || selected.size >= limit) return;
    if (nodeById.has(id)) selected.add(id);
  };

  add(focusId);
  if (focusId) {
    const focusPoolId = focusId.startsWith("intent_")
      ? `pool:${focusId}`
      : nodeById.get(focusId)?.pool_id;
    for (const node of nodes) {
      if (selected.size >= limit) break;
      if (node.pool_id === focusPoolId) add(node.id);
    }
    for (const link of links) {
      if (selected.size >= limit) break;
      if (link.source === focusId) add(link.target);
      else if (link.target === focusId) add(link.source);
    }
  }

  const ordered = [...nodes].sort(compareBpmnNodesForLargeDoco);
  for (const node of ordered) {
    add(node.id);
    if (selected.size >= limit) break;
  }
  return selected;
}

function compareBpmnNodesForLargeDoco(a: BpmnNode, b: BpmnNode): number {
  const lifecycleDiff = lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle);
  if (lifecycleDiff !== 0) return lifecycleDiff;
  const dateDiff = Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "");
  if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
  return a.id.localeCompare(b.id);
}

function lifecycleRank(lifecycle: string | null | undefined): number {
  switch (lifecycle ?? "asserted") {
    case "asserted":
      return 0;
    case "drafting":
      return 1;
    case "retired":
      return 3;
    default:
      return 4;
  }
}

function sequenceFlowLabel(props: Record<string, unknown> | null): string | null {
  if (!props) return null;
  const raw = props.label ?? props.condition;
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/\s+/g, " ");
  if (!compact) return null;
  return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function bpmnLinkFromEdgeRow(row: EdgeRow, handle: string | undefined): OverviewGraphLink {
  const href = handle ? `/${handle}/edges/${row.id}` : null;
  if (
    row.edge_type === "flows_to" &&
    (row.edge_props_json?.source_field === "preceded_by" ||
      row.edge_props_json?.role === "predecessor")
  ) {
    return {
      id: row.id,
      source: row.to_id,
      target: row.from_id,
      edge_type: "flows_to",
      label: sequenceFlowLabel(row.edge_props_json),
      href,
    };
  }
  return {
    id: row.id,
    source: row.from_id,
    target: row.to_id,
    edge_type: row.edge_type,
    label: row.edge_type === "flows_to" ? sequenceFlowLabel(row.edge_props_json) : null,
    href,
  };
}

export function computeNearestIntentByNode(
  intentIds: readonly string[],
  links: readonly OverviewGraphLink[],
  ranks: ReadonlyMap<string, number>,
): Map<string, string> {
  const uniqueIntentIds = Array.from(new Set(intentIds));
  const adjacency = new Map<string, Set<string>>();
  const connect = (from: string, to: string) => {
    const existing = adjacency.get(from);
    if (existing) existing.add(to);
    else adjacency.set(from, new Set([to]));
  };

  for (const link of links) {
    connect(link.source, link.target);
    connect(link.target, link.source);
  }

  const orderedIntents = uniqueIntentIds.sort((a, b) => {
    const rankDiff = (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });
  const nearest = new Map<string, string>();
  const queue: string[] = [];
  for (const intentId of orderedIntents) {
    nearest.set(intentId, intentId);
    queue.push(intentId);
  }

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const currentIntent = nearest.get(current);
    if (!currentIntent) continue;
    const neighbors = Array.from(adjacency.get(current) ?? []).sort();
    for (const neighbor of neighbors) {
      if (nearest.has(neighbor)) continue;
      nearest.set(neighbor, currentIntent);
      queue.push(neighbor);
    }
  }

  return nearest;
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
  userById: Map<string, UserRow>,
): string | null {
  switch (entityType) {
    case "action":
    case "log":
      return firstString(data.actor_id) ?? firstString(data.actor);
    case "decision": {
      const ref = firstString(data.decided_by);
      if (!ref) return null;
      if (ref.startsWith("user_")) {
        const collab = userById.get(ref);
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
  row: NodeRow,
  allRows: NodeRow[],
  principalById: Map<string, PrincipalRow>,
  principalByName: Map<string, PrincipalRow>,
  userById: Map<string, UserRow>,
): { id: string; label: string } | null {
  if (row.entity_type === "rule") {
    for (const candidate of allRows) {
      if (candidate.entity_type !== "action") continue;
      const gatedBy = toStringArray(candidate.data?.gated_by);
      if (!gatedBy.includes(row.id)) continue;
      const ref = laneReferenceFor("action", candidate.data ?? {}, userById);
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
    const ref = laneReferenceFor(target.entity_type, target.data ?? {}, userById);
    const resolved = resolveLane(ref, principalById, principalByName);
    if (resolved.id.startsWith("principal_")) return resolved;
    return null;
  }
  return null;
}

interface LaneEntryOrder {
  firstActionDepth: number;
  firstAnyDepth: number;
  firstCreatedAt: number;
}

function computeLaneEntryOrder(
  nodes: readonly BpmnNode[],
  links: readonly OverviewGraphLink[],
): Map<string, LaneEntryOrder> {
  const depthByNode = computeForwardSequenceDepths(nodes, links);
  const orderByLane = new Map<string, LaneEntryOrder>();

  for (const node of nodes) {
    const entry = orderByLane.get(node.laneId) ?? {
      firstActionDepth: Number.POSITIVE_INFINITY,
      firstAnyDepth: Number.POSITIVE_INFINITY,
      firstCreatedAt: Number.POSITIVE_INFINITY,
    };
    const depth = depthByNode.get(node.id) ?? 0;
    if (depth < entry.firstAnyDepth) entry.firstAnyDepth = depth;
    if (node.entity_type === "action" && depth < entry.firstActionDepth) {
      entry.firstActionDepth = depth;
    }
    const createdAt = node.created_at ? Date.parse(node.created_at) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(createdAt) && createdAt < entry.firstCreatedAt) {
      entry.firstCreatedAt = createdAt;
    }
    orderByLane.set(node.laneId, entry);
  }

  return orderByLane;
}

function compareLaneEntryOrder(
  a: LaneEntryOrder | undefined,
  b: LaneEntryOrder | undefined,
): number {
  const aAction = a?.firstActionDepth ?? Number.POSITIVE_INFINITY;
  const bAction = b?.firstActionDepth ?? Number.POSITIVE_INFINITY;
  if (aAction !== bAction) return aAction - bAction;

  const aAny = a?.firstAnyDepth ?? Number.POSITIVE_INFINITY;
  const bAny = b?.firstAnyDepth ?? Number.POSITIVE_INFINITY;
  if (aAny !== bAny) return aAny - bAny;

  const aCreated = a?.firstCreatedAt ?? Number.POSITIVE_INFINITY;
  const bCreated = b?.firstCreatedAt ?? Number.POSITIVE_INFINITY;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return 0;
}
