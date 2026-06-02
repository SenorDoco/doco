// BPMN perspective server-side data loader.
//
// The canvas is partitioned into **pools** — one per Intent in the
// Doco. A pool is a bordered horizontal section with its own internal
// structure (milestone band on top, actor lanes in the middle,
// artifacts band on the bottom). Pools stack vertically. An
// "Unassigned" pool catches nodes that don't cite an Intent.
//
// Inside each pool, lane assignment follows a three-category model:
//   - Milestone band (top of the pool): States.
//   - Actor lanes (middle): one per Principal who has work in this
//     pool. attributed_to edges with performed_by / decided_by / owned_by
//     roles drive the
//     placement. Decisions whose decided_by edge points at a
//     `user_*` id walk through the user → github_login
//     → matching Principal name path; rows that don't resolve land in
//     Unassigned.
//   - Artifacts band (bottom): References, Ideas, plus any Rule/Eval
//     that didn't re-home onto an Action via constrained_by/supports role edges.
//
// Intents themselves are *not* rendered as flow nodes — they're pool
// headers. The Intent's prose labels its pool.
//
// Pool selection for flow nodes that serve multiple Intents uses
// **PageRank**: the candidate Intent with the highest score on the doco's
// edge graph wins. With no focal node, this is plain global PageRank; the
// personalized variant (teleport biased to a focal node) is computed
// client-side from `centerId` so the same graph can re-pool around
// whichever node the user clicked into.
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

import type { OverviewGraphLink } from "~/components/overview-graph";
import { computeForwardSequenceDepths } from "./bpmn-sequence-depth";
import { highestRanked, pageRank } from "./pagerank";
import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";

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
  /** Full list of served Intent ids so the client can recompute the primary
   *  Intent under personalized PageRank without re-fetching. */
  served_intent_ids?: string[];
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
  /**
   * TRUE total of BPMN flow nodes ("steps") for this Doco, counted before the
   * server node cap. `nodes.length` is the delivered slice; the header reports
   * delivered vs this total. Optional so fixtures/mocks stay valid — the loader
   * always sets it.
   */
  totalCount?: number;
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
  opts: {
    focusId?: string;
    handle?: string;
    nodeLimit?: number;
    window?: PerspectiveWindowSelection;
  } = {},
): Promise<BpmnGraphData> {
  // Post-collapse: one `nodes` query over the eight BPMN node types
  // (BPMN_TABLES deliberately excludes logs and principals — principals
  // are loaded separately below as actor lanes). `summary` is the first
  // line of `prose`.
  const bpmnTypeList = BPMN_TABLES.map((entry) => `'${entry.entityType}'`).join(", ");
  const windowIds = windowNodeIds(opts.window);
  const nodeParams: unknown[] = [docoId];
  if (windowIds.length > 0) nodeParams.push(windowIds);
  const nodeSql = `SELECT t.id,
              t.node_type AS entity_type,
              split_part(t.prose, E'\n', 1) AS summary,
              COALESCE(t.lifecycle, 'asserted') AS lifecycle,
              t.created_at::text AS created_at,
              t.data
         FROM nodes t
        WHERE t.doco_id = $1
          AND t.node_type IN (${bpmnTypeList})
          AND COALESCE(t.lifecycle, 'asserted') <> 'retired'
          ${windowIds.length > 0 ? "AND t.id = ANY($2::text[])" : ""}`;

  const [nodeRows, principalRows, userRows] = await Promise.all([
    c.query<NodeRow>(nodeSql, nodeParams),
    c.query<PrincipalRow>(
      `SELECT id, name, COALESCE(lifecycle, 'asserted') AS lifecycle
         FROM nodes
        WHERE node_type = 'principal'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
          ${windowIds.length > 0 ? "AND id = ANY($2::text[])" : ""}`,
      nodeParams,
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

  // Load outgoing edges up front: rendered links use the rows whose target is
  // also a BPMN node, while pool/lane assignment reads the full outgoing map
  // including Principal targets.
  const nodeIdSet = new Set(allRows.map((r) => r.id));
  const outgoingByType = new Map<string, Map<string, EdgeRow[]>>();
  let links: OverviewGraphLink[] = [];
  if (nodeIdSet.size > 0) {
    const edgeRows = await c.query<EdgeRow>(
      `SELECT id, from_id, to_id, edge_type, props AS edge_props_json
         FROM edges
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        LIMIT 5000`,
      [docoId, Array.from(nodeIdSet)],
    );
    for (const row of edgeRows.rows) addOutgoingEdge(outgoingByType, row);
    links = edgeRows.rows
      .filter((r) => nodeIdSet.has(r.to_id))
      .map((r) => bpmnLinkFromEdgeRow(r, opts.handle));
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
  // 2. Flow nodes (Action / Decision / State / Log) with serving Intent edges
  //    go in their primary Intent's pool (PR-picked).
  // 3. Flow nodes with no serving Intent edges → Unassigned.
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
    if (
      row.entity_type === "action" ||
      row.entity_type === "decision" ||
      row.entity_type === "state" ||
      row.entity_type === "log"
    ) {
      const intentIds = edgeTargets(outgoingByType, row.id, "serves").filter((id) =>
        intentsById.has(id),
      );
      if (intentIds.length > 0) intentIdsByNode.set(row.id, intentIds);
      const primary = intentIds.length > 0 ? highestRanked(intentIds, pr) : null;
      poolByNode.set(row.id, primary ? `pool:${primary}` : POOL_UNASSIGNED_ID);
    } else {
      poolByNode.set(row.id, POOL_UNASSIGNED_ID);
    }
  }

  // Re-home Rules into the pool of any Action that points to them with
  // constrained_by/role=gated_by. First Action wins (cross-pool duplication is
  // a later phase).
  for (const row of allRows) {
    if (row.entity_type !== "action") continue;
    const gatedBy = edgeTargets(outgoingByType, row.id, "gated_by");
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

  // Re-home Evals to their tested target's pool when the target lives
  // in a real Intent pool (not Unassigned).
  for (const row of allRows) {
    if (row.entity_type !== "eval") continue;
    const targetRef = firstEdgeTarget(outgoingByType, row.id, "tests");
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
    let baseId: string;
    let kind: BpmnLaneKind;
    let label: string;

    if (row.entity_type === "state") {
      baseId = BAND_MILESTONE_BASE;
      kind = "milestone";
      label = "Milestones";
    } else if (ARTIFACT_TYPES.has(row.entity_type)) {
      // A Rule or Eval that re-homed onto an actor-type host
      // (constrained_by/supports role edge) lands in the host's
      // *actor* lane, not the artifacts band. Others stay in artifacts.
      const hostLane = resolveRehomeHostLane(
        row,
        allRows,
        outgoingByType,
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
      const ref = laneReferenceFor(row.entity_type, row.id, outgoingByType, userById);
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
    if (intentIds && intentIds.length > 0) node.served_intent_ids = intentIds;
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
  // The full built graph holds every flow node ("step"); capture that as the
  // true total before any cap so the header can say "Showing the latest N of M".
  const totalCount = graph.nodes.length;
  if (!nodeLimit || graph.nodes.length <= nodeLimit) return { ...graph, totalCount };

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
  return { pools, lanes, nodes, links, global_pagerank: globalPagerank, totalCount };
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
  const displayType = edgeRole(row);
  return {
    id: row.id,
    source: row.from_id,
    target: row.to_id,
    edge_type: displayType,
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

type OutgoingEdgesByType = Map<string, Map<string, EdgeRow[]>>;

function edgeRole(edge: EdgeRow): string {
  return typeof edge.edge_props_json?.role === "string"
    ? edge.edge_props_json.role
    : edge.edge_type;
}

function addOutgoingEdge(outgoing: OutgoingEdgesByType, edge: EdgeRow) {
  let byType = outgoing.get(edge.from_id);
  if (!byType) {
    byType = new Map();
    outgoing.set(edge.from_id, byType);
  }
  const key = edgeRole(edge);
  const list = byType.get(key) ?? [];
  list.push(edge);
  byType.set(key, list);
}

function edgeTargets(outgoing: OutgoingEdgesByType, fromId: string, edgeType: string): string[] {
  return (outgoing.get(fromId)?.get(edgeType) ?? []).map((edge) => edge.to_id);
}

function firstEdgeTarget(
  outgoing: OutgoingEdgesByType,
  fromId: string,
  edgeType: string,
): string | null {
  return edgeTargets(outgoing, fromId, edgeType)[0] ?? null;
}

function laneReferenceFor(
  entityType: string,
  rowId: string,
  outgoing: OutgoingEdgesByType,
  userById: Map<string, UserRow>,
): string | null {
  switch (entityType) {
    case "action":
    case "log":
      return firstEdgeTarget(outgoing, rowId, "performed_by");
    case "decision": {
      const ref = firstEdgeTarget(outgoing, rowId, "decided_by");
      if (!ref) return null;
      if (ref.startsWith("user_")) {
        const collab = userById.get(ref);
        return collab?.github_login ?? null;
      }
      return ref;
    }
    case "intent":
      return (
        firstEdgeTarget(outgoing, rowId, "performed_by") ??
        firstEdgeTarget(outgoing, rowId, "owned_by")
      );
    default:
      return null;
  }
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
 * Find the actor lane base for a Rule (via any Action's gated_by role edge) or
 * Eval (via its tests role edge) so artifacts can relocate onto the host lane.
 * Returns null when no host with a resolved actor lane exists.
 */
function resolveRehomeHostLane(
  row: NodeRow,
  allRows: NodeRow[],
  outgoing: OutgoingEdgesByType,
  principalById: Map<string, PrincipalRow>,
  principalByName: Map<string, PrincipalRow>,
  userById: Map<string, UserRow>,
): { id: string; label: string } | null {
  if (row.entity_type === "rule") {
    for (const candidate of allRows) {
      if (candidate.entity_type !== "action") continue;
      const gatedBy = edgeTargets(outgoing, candidate.id, "gated_by");
      if (!gatedBy.includes(row.id)) continue;
      const ref = laneReferenceFor("action", candidate.id, outgoing, userById);
      const resolved = resolveLane(ref, principalById, principalByName);
      if (resolved.id.startsWith("principal_")) return resolved;
      return null;
    }
    return null;
  }
  if (row.entity_type === "eval") {
    const targetRef = firstEdgeTarget(outgoing, row.id, "tests");
    if (!targetRef) return null;
    const target = allRows.find((r) => r.id === targetRef);
    if (!target) return null;
    const ref = laneReferenceFor(target.entity_type, target.id, outgoing, userById);
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
