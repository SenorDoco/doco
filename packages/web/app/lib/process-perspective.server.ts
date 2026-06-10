// BPMN perspective server-side data loader.
//
// The canvas is partitioned into **pools** — one per **process**. A
// process is an Action that has one or more **child actions** linked to it by a
// `has_parent` edge; other flow nodes (gateway Decisions, milestone States) that
// point at it join the same pool as members. Process-ness comes from those child
// actions, never from the author's `top_level` flag — a top-level Action with no
// children is not a process. The process Action itself is the pool,
// never a member of its own pool. A pool is a bordered horizontal section
// with its own internal structure (milestone band on top, actor lanes in
// the middle, artifacts band on the bottom). Pools stack vertically. An
// "Unassigned" pool catches flow nodes with no `has_parent`.
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
//   - Artifacts band (bottom): Ideas, plus any Rule/Eval that didn't
//     re-home onto an Action via constrained_by/supports role edges.
//
// A **subprocess** is a member Action that is itself a process (it has its
// own child actions). It renders as an ordinary member of its
// parent's pool, and can be expanded into its own pool — there is no
// separate "calling Action ↔ purpose Intent" pairing anymore.
//
// Membership is single-valued: a flow node points at AT MOST one parent
// process via `has_parent`, so it belongs to exactly one pool. There is no
// PageRank pool tie-break to run.
//
// Shape map:
//   decision                → diamond     (BPMN gateway)
//   action                  → task        (BPMN rounded-rect task)
//   rule                    → rectangle   (policy box)
//   state                   → rounded     (milestone-band pill)
//   eval                    → document    (BPMN data object)
//   idea                    → rounded     (capsule)
//
// Not rendered: Intent (goals live outside the process model now), Log
// (instances, not designs), or Reference (source/background material, not
// a process step).

import type { OverviewGraphLink } from "~/components/overview-graph";
import { lifecycleRenderRank } from "./node-colors";
import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";
import { computeForwardSequenceDepths } from "./process-sequence-depth";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type ProcessShape =
  | "circle"
  | "diamond"
  | "rectangle"
  | "document"
  | "rounded"
  | "task"
  | "milestone";

export type ProcessLaneKind = "milestone" | "actor" | "artifacts" | "unassigned" | "unresolved";

export interface ProcessPool {
  id: string; // "pool:<process_action_id>" or POOL_UNASSIGNED_ID
  process_id: string | null; // the process Action's id; null for the Unassigned pool
  label: string; // the process Action's prose, or "Unassigned"
  /** The process Action's lifecycle (drafting / queued / active / retired).
   *  Null for the Unassigned pool. Drives the lifecycle badge on the pool
   *  header. */
  lifecycle: string | null;
}

export interface ProcessLane {
  /** Composite id: `${pool_id}::${base}`. Unique across the canvas. */
  id: string;
  pool_id: string;
  /** `principal_<ulid>`, BAND_MILESTONE_BASE, BAND_ARTIFACTS_BASE, or
   *  BAND_UNASSIGNED_BASE / `__unresolved__:<raw-ref>`. The bare base
   *  (without the pool prefix) is recorded for renderer convenience —
   *  e.g. to look up the Principal row for an actor lane. */
  base_id: string;
  label: string;
  kind: ProcessLaneKind;
  /** Underlying entity's lifecycle when the lane represents a node
   *  (actor lanes carry the Principal's lifecycle). Null for bands
   *  and synthetic catch-all lanes — they have no single owning
   *  node. */
  lifecycle: string | null;
}

export interface ProcessNode {
  id: string;
  node_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href: string | null;
  shape: ProcessShape;
  laneId: string;
  pool_id: string;
  /** True when this node is itself a process — an Action with one or more
   *  child actions linked to it by `has_parent`. Derived from those children,
   *  never from the `top_level` flag: a top-level Action with no children is NOT
   *  a process. Such a node renders as a collapsed subprocess (a task with a
   *  "View subprocess" affordance) inside its parent's pool, and can be expanded
   *  into its own pool (`pool:<id>`). */
  is_process?: boolean;
  /**
   * Server-side sequence-flow depth. The renderer uses this as a floor
   * for horizontal sequence layout so incoming flow targets stay to
   * the right of their source.
   */
  bfs_depth?: number;
  /**
   * BPMN sequence-flow markings, author-set in the node's `extra` (never
   * deduced). `entry_point` (a way into the process — pinned to the first
   * column, drawn with a start-event glyph) and `exit_point` (a way out —
   * end-event glyph) drive the renderer; `top_level` marks a top-level (root)
   * Action that heads the overview.
   */
  entry_point?: boolean;
  exit_point?: boolean;
  top_level?: boolean;
}

export interface ProcessGraphData {
  pools: ProcessPool[];
  lanes: ProcessLane[];
  nodes: ProcessNode[];
  links: OverviewGraphLink[];
}

const PROCESS_TABLES: { table: string; nodeType: string }[] = [
  { table: "decisions", nodeType: "decision" },
  { table: "actions", nodeType: "action" },
  { table: "rules", nodeType: "rule" },
  { table: "evals", nodeType: "eval" },
  { table: "states", nodeType: "state" },
  { table: "ideas", nodeType: "idea" },
];

// Flow nodes carry process sequence and pool membership: Action, gateway
// Decision, milestone/event State. Artifacts (Eval / Idea / Rule) attach
// alongside the flow rather than sitting in it.
const FLOW_TYPES = new Set(["action", "decision", "state"]);

// Lane id "bases" (the part after the `pool_id::` prefix). The same
// base lives in every pool that uses it; the composite lane id ties
// it to one specific pool.
const BAND_MILESTONE_BASE = "__milestones__";
const BAND_ARTIFACTS_BASE = "__artifacts__";
const BAND_UNASSIGNED_BASE = "__unassigned__";

export const POOL_UNASSIGNED_ID = "pool:unassigned";

// The synthetic overview pool — one pool that is NOT an Action, holding every
// author-declared top-level Action (flagged `top_level`) as a task node in its
// principal's lane. It is the BPMN home: the same swim-lane rendering used
// everywhere else, in place of a bespoke flat directory list. (Being top-level
// does not make an Action a process; that is decided per node by `is_process`.)
export const POOL_TOP_LEVEL_ID = "pool:top-level";

// Non-actor node types: their pool placement comes from a different
// signal (the host they re-home onto, or the Unassigned pool).
const ARTIFACT_TYPES = new Set(["eval", "idea", "rule"]);
const SHAPE_BY_TYPE: Record<string, ProcessShape> = {
  // State is a milestone/outcome — a condition that holds — so it wears the
  // stadium pill, full-sized and readable but unmistakably not the Action's
  // task glyph. The pill is the State's alone: Ideas (the former pill) are
  // not process content and are barred by the process node-type
  // allowlist, so reusing "rounded" here carries no ambiguity.
  state: "rounded",
  decision: "diamond",
  action: "task",
  rule: "rectangle",
  eval: "document",
};

export function shapeForEntityType(nodeType: string): ProcessShape {
  return SHAPE_BY_TYPE[nodeType] ?? "rectangle";
}

interface NodeRow {
  id: string;
  node_type: string;
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
  lifecycle: string | null;
  label: string | null;
  condition: string | null;
}

export async function loadProcessGraph(
  c: QueryClient,
  docoId: string,
  opts: {
    focusId?: string;
    handle?: string;
    nodeLimit?: number;
    window?: PerspectiveWindowSelection;
  } = {},
): Promise<ProcessGraphData> {
  // Post-collapse: one `nodes` query over the eight BPMN node types
  // (PROCESS_TABLES deliberately excludes logs and principals — principals
  // are loaded separately below as actor lanes). `summary` is the node's
  // full `prose` — perspectives render the complete node name, not just its
  // first line (the box auto-sizes to the label via sizeForNode).
  //
  // Every lifecycle is loaded — including retired. Hiding a lifecycle is
  // the client's job: the page-level lifecycle filter (`visibleLifecycles`,
  // retired hidden by default) is applied in ProcessPerspective. Pre-filtering
  // retired here would make toggling "Retired" on a no-op, leaving the
  // canvas "So empty" for a retired process. This mirrors the Graph/List
  // loader (full-graph.server), which also returns every lifecycle.
  const allowedNodeTypes = new Set(PROCESS_TABLES.map((entry) => entry.nodeType));
  const processTypeList = PROCESS_TABLES.map((entry) => `'${entry.nodeType}'`).join(", ");
  const windowIds = windowNodeIds(opts.window);
  const nodeParams: unknown[] = [docoId];
  if (windowIds.length > 0) nodeParams.push(windowIds);
  const nodeSql = `SELECT t.id,
              t.node_type,
              t.prose AS summary,
              COALESCE(t.lifecycle, 'active') AS lifecycle,
              t.created_at::text AS created_at,
              t.extra AS data
         FROM nodes t
        WHERE t.doco_id = $1
          AND t.node_type IN (${processTypeList})
          ${windowIds.length > 0 ? "AND t.id = ANY($2::text[])" : ""}`;

  const [nodeRows, principalRows, userRows] = await Promise.all([
    c.query<NodeRow>(nodeSql, nodeParams),
    c.query<PrincipalRow>(
      // Load Principals of every lifecycle (including retired). In BPMN a
      // Principal is a swim *lane*, not a flow node, and a lane only renders
      // when a lifecycle-visible node sits in it (render-gated client-side).
      // So loading a retired Principal adds no noise on its own — it ensures
      // retired nodes land in a correctly-named lane (rather than an
      // `__unresolved__:<id>` fallback) once "Retired" is toggled on.
      //
      // And load every Principal in the Doco — deliberately NOT window-gated.
      // In a focused window the flow nodes that sit in a lane make the cut, but
      // the Principal node that owns the lane usually doesn't (it's a neighbor
      // of an Action, not the focus Intent, and its low type weight rarely
      // survives the ranked-fill budget). Window-gating the principal query
      // dropped it from `principalById`, so `resolveLane` fell through to
      // `__unresolved__:<id>` and the lane header rendered the raw
      // `principal_…` id instead of its name. There are only a handful of
      // Principals per Doco, so loading all of them is cheap insurance that
      // every actor lane resolves to a name.
      `SELECT id, prose AS name, COALESCE(lifecycle, 'active') AS lifecycle
         FROM nodes
        WHERE node_type = 'principal'
          AND doco_id = $1`,
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

  // PROCESS_TABLES is the single source of truth for which node types this
  // perspective renders. The SQL above already restricts to those types
  // (so References and other excluded types are never fetched); this guard
  // keeps the JS in lockstep with that list — a References row that somehow
  // arrives (e.g. from a query client that ignores the type filter) is
  // dropped before it can reach the node cap, PageRank, pooling, or layout.
  const allRows = nodeRows.rows.filter((row) => allowedNodeTypes.has(row.node_type));

  // Index of every Action row by id — Actions are the process containers
  // (a process is an Action with child actions) and label their pools.
  const actionsById = new Map<string, NodeRow>();
  for (const row of allRows) {
    if (row.node_type === "action") actionsById.set(row.id, row);
  }

  // Load outgoing edges up front: rendered links use the rows whose target is
  // also a BPMN node, while pool/lane assignment reads the full outgoing map
  // including Principal targets.
  const nodeIdSet = new Set(allRows.map((r) => r.id));
  const outgoingByType = new Map<string, Map<string, EdgeRow[]>>();
  let links: OverviewGraphLink[] = [];
  if (nodeIdSet.size > 0) {
    const edgeRows = await c.query<EdgeRow>(
      // Edges of every lifecycle, too: a retired process's `flows_to`
      // sequence edges are themselves retired, and the client only draws an
      // edge when both endpoints are visible. Excluding retired edges here
      // would leave revealed retired nodes disconnected. Matches the
      // Graph/List loader, which applies no lifecycle filter to edges.
      `SELECT id, from_id, to_id, edge_type,
              COALESCE(lifecycle, 'active') AS lifecycle, label, condition
         FROM edges
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
        LIMIT 5000`,
      [docoId, Array.from(nodeIdSet)],
    );
    for (const row of edgeRows.rows) addOutgoingEdge(outgoingByType, row);
    links = edgeRows.rows
      .filter((r) => nodeIdSet.has(r.to_id))
      .map((r) => processLinkFromEdgeRow(r, opts.handle));
  }

  // ── Process membership (`has_parent`) ───────────────────────────
  // A flow node belongs to the process it points at with a `has_parent`
  // edge whose other endpoint is an Action. That parent Action is the
  // process (its pool); membership is single-valued, so the first such
  // parent wins (the template caps `has_parent` at one). An Action is a
  // process only when it has ≥1 CHILD ACTION pointing at it — gateway
  // Decisions and milestone States are members of a process, not what makes
  // one. (Being flagged `top_level` never makes an Action a process either.)
  const parentProcessByNode = new Map<string, string>();
  const processIds = new Set<string>();
  for (const row of allRows) {
    if (!FLOW_TYPES.has(row.node_type)) continue;
    const parent = edgeTargets(outgoingByType, row.id, "has_parent").find((id) =>
      actionsById.has(id),
    );
    if (!parent) continue;
    parentProcessByNode.set(row.id, parent);
    if (row.node_type === "action") processIds.add(parent);
  }

  // An Action HEADS its own pool when it is a process (has child actions)
  // OR a root (no parent process of its own). The latter is what
  // surfaces every top-level Action in the BPMN home view — even one with no
  // sub-steps yet — so a freshly-sketched flat process isn't invisible. A
  // subprocess (an Action with both a parent and child actions) heads a pool
  // too, so it can be expanded. Leaf member Actions (a parent, no children) do not.
  const poolActionIds = new Set<string>(processIds);
  for (const row of allRows) {
    if (row.node_type !== "action") continue;
    if (!parentProcessByNode.has(row.id)) poolActionIds.add(row.id);
  }

  // ── Deterministic pool-action precedence (no PageRank) ──────────────
  // A stable ordering over pool-heading Actions used for pool order (oldest
  // first) and the homeless-node nearest-pool fallback. Score is higher for
  // older actions (negated created_at); missing timestamps sort last. Ties fall
  // through to id order downstream.
  const processPrecedence = new Map<string, number>();
  for (const id of poolActionIds) {
    const ms = actionsById.get(id)?.created_at
      ? Date.parse(actionsById.get(id)?.created_at ?? "")
      : Number.NaN;
    processPrecedence.set(id, Number.isFinite(ms) ? -ms : Number.NEGATIVE_INFINITY);
  }

  // ── Pool assignment per node ────────────────────────────────────
  // 1. A flow node with a parent process goes in that process's pool
  //    ("pool:<process_action_id>").
  // 2. A flow node with no parent process → Unassigned (nearest-process BFS
  //    below may still re-home it).
  // 3. Artifacts (Idea / Rule / Eval) start in Unassigned; Rules and Evals
  //    get re-homed below if they have a host node whose pool is known.
  const poolByNode = new Map<string, string>();

  for (const row of allRows) {
    if (FLOW_TYPES.has(row.node_type)) {
      const parent = parentProcessByNode.get(row.id);
      if (parent) {
        poolByNode.set(row.id, `pool:${parent}`);
      } else if (poolActionIds.has(row.id)) {
        // A top-level Action (a root, whether or not it has children) is a pool
        // header, not a member: it gets no pool *membership* (its own pool is
        // built from poolActionIds below).
      } else {
        poolByNode.set(row.id, POOL_UNASSIGNED_ID);
      }
    } else {
      poolByNode.set(row.id, POOL_UNASSIGNED_ID);
    }
  }

  // Re-home Rules into the pool of any Action that points to them with
  // constrained_by/role=gated_by. First Action wins (cross-pool duplication is
  // a later phase).
  for (const row of allRows) {
    if (row.node_type !== "action") continue;
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
    if (row.node_type !== "eval") continue;
    const targetRef = firstEdgeTarget(outgoingByType, row.id, "tests");
    if (!targetRef) continue;
    const targetPool = poolByNode.get(targetRef);
    if (targetPool && targetPool !== POOL_UNASSIGNED_ID) {
      poolByNode.set(row.id, targetPool);
    }
  }

  // ── Nearest-process re-homing (connected nodes only) ─────────────
  // Homeless flow/artifact nodes are pulled into the pool of the nearest
  // process they actually reach through the edge graph, via a single
  // multi-source BFS from all process Actions. Direct membership/host rules
  // above win. A process Action itself is never re-homed — it is its own
  // pool's header — so it is excluded from the homeless set.
  //
  // Crucially, a node with NO path to any process is left in the real
  // Unassigned pool rather than force-homed into an arbitrary process.
  if (poolActionIds.size > 0) {
    const homeless: NodeRow[] = [];
    for (const row of allRows) {
      if (poolActionIds.has(row.id)) continue;
      if (poolByNode.get(row.id) === POOL_UNASSIGNED_ID) homeless.push(row);
    }
    if (homeless.length > 0) {
      const nearestProcessByNode = computeNearestProcessByNode(
        Array.from(poolActionIds),
        links,
        processPrecedence,
      );
      for (const row of homeless) {
        const bestProcess = nearestProcessByNode.get(row.id);
        if (bestProcess) poolByNode.set(row.id, `pool:${bestProcess}`);
      }
    }
  }

  // ── Lane assignment within each pool ──────────────────────────────
  // A lane id is composite: `${pool_id}::${base}` — alice in pool 1
  // and alice in pool 2 are different lanes with the same `base_id`
  // (`principal_alice`) but different pool_id. The renderer keys off
  // `id` and walks `pool_id` to group.
  const lanesById = new Map<string, ProcessLane>();
  const nodes: ProcessNode[] = [];

  // One construction path for a member node: both the regular pools and the
  // synthetic top-level pool build their nodes here, so the `is_process` flag
  // and the BPMN flow markings (`entry_point`, `exit_point`, `top_level`)
  // always travel with the node — a top-level Action that is also a flow entry
  // point keeps its `entry_point` in the overview.
  const makeNode = (row: NodeRow, laneId: string, poolId: string): ProcessNode => {
    const node: ProcessNode = {
      id: row.id,
      node_type: row.node_type,
      name: row.summary,
      lifecycle: row.lifecycle,
      created_at: row.created_at,
      href: opts.handle ? `/${opts.handle}/${row.node_type}/${row.id}` : null,
      shape: shapeForEntityType(row.node_type),
      laneId,
      pool_id: poolId,
    };
    if (processIds.has(row.id)) node.is_process = true;
    // BPMN flow markings ride in the node's `extra` (here `data`), surfaced flat.
    const data = row.data ?? {};
    if (data.entry_point === true) node.entry_point = true;
    if (data.exit_point === true) node.exit_point = true;
    if (data.top_level === true) node.top_level = true;
    return node;
  };

  for (const row of allRows) {
    // A top-level Action (a pool head with no parent of its own) is a pool
    // header, never a member node. A subprocess (a pool-heading Action that
    // *does* have a parent) still renders as a member of its parent's pool.
    if (poolActionIds.has(row.id) && !parentProcessByNode.has(row.id)) continue;
    const poolId = poolByNode.get(row.id) ?? POOL_UNASSIGNED_ID;
    let baseId: string;
    let kind: ProcessLaneKind;
    let label: string;

    if (row.node_type === "state") {
      baseId = BAND_MILESTONE_BASE;
      kind = "milestone";
      label = "Milestones";
    } else if (ARTIFACT_TYPES.has(row.node_type)) {
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
      const ref = laneReferenceFor(row.node_type, row.id, outgoingByType, userById);
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

    nodes.push(makeNode(row, laneId, poolId));
  }

  // ── Synthetic top-level pool ──────────────────────────────────────
  // Every author-declared top-level Action (flagged `top_level`) renders as a
  // task node inside ONE synthetic pool that is not itself an Action, each
  // placed in its principal's actor lane (resolved from its performed_by edge,
  // falling back to an Unassigned lane). This is the overview (home) view — the
  // same swim-lane rendering used everywhere else. A flagged Action still heads
  // its own pool (built below), so opening it drills into that pool's members.
  let topLevelPoolUsed = false;
  for (const row of allRows) {
    if (row.node_type !== "action") continue;
    if (row.data?.top_level !== true) continue;
    const ref = laneReferenceFor("action", row.id, outgoingByType, userById);
    const resolved = resolveLane(ref, principalById, principalByName);
    const baseId = resolved.id;
    const kind: ProcessLaneKind = baseId.startsWith("principal_")
      ? "actor"
      : baseId === BAND_UNASSIGNED_BASE
        ? "unassigned"
        : "unresolved";
    const laneId = `${POOL_TOP_LEVEL_ID}::${baseId}`;
    if (!lanesById.has(laneId)) {
      lanesById.set(laneId, {
        id: laneId,
        pool_id: POOL_TOP_LEVEL_ID,
        base_id: baseId,
        label: resolved.label,
        kind,
        lifecycle: kind === "actor" ? (principalById.get(baseId)?.lifecycle ?? null) : null,
      });
    }
    nodes.push(makeNode(row, laneId, POOL_TOP_LEVEL_ID));
    topLevelPoolUsed = true;
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
  // One pool per pool-heading Action (every Action that is a process — has ≥1
  // child action — plus every root Action), so the home view lists every top-level Action.
  // The Unassigned pool appears only when some orphan landed there.
  const pools: ProcessPool[] = [];
  const usedPoolIds = new Set<string>();
  for (const id of poolByNode.values()) usedPoolIds.add(id);
  for (const poolActionId of poolActionIds) usedPoolIds.add(`pool:${poolActionId}`);

  for (const id of usedPoolIds) {
    if (id === POOL_UNASSIGNED_ID) {
      pools.push({
        id: POOL_UNASSIGNED_ID,
        process_id: null,
        label: "Unassigned",
        lifecycle: null,
      });
      continue;
    }
    const processId = id.startsWith("pool:") ? id.slice("pool:".length) : null;
    if (!processId) continue;
    const processRow = actionsById.get(processId);
    const label = processRow?.summary?.trim() || "(unnamed process)";
    pools.push({
      id,
      process_id: processId,
      label,
      lifecycle: processRow?.lifecycle ?? null,
    });
  }

  // The synthetic overview pool, when it has any top-level Actions to hold.
  if (topLevelPoolUsed) {
    pools.push({ id: POOL_TOP_LEVEL_ID, process_id: null, label: "Processes", lifecycle: null });
  }

  // Pool order: the synthetic overview pool pinned to the top, then process
  // pools oldest-first (deterministic, no PageRank), ties broken by process id;
  // Unassigned pinned to the bottom.
  pools.sort((a, b) => {
    if (a.id === POOL_TOP_LEVEL_ID) return -1;
    if (b.id === POOL_TOP_LEVEL_ID) return 1;
    if (a.id === POOL_UNASSIGNED_ID) return 1;
    if (b.id === POOL_UNASSIGNED_ID) return -1;
    const pa = a.process_id ? (processPrecedence.get(a.process_id) ?? Number.NEGATIVE_INFINITY) : 0;
    const pb = b.process_id ? (processPrecedence.get(b.process_id) ?? Number.NEGATIVE_INFINITY) : 0;
    if (pa !== pb) return pb - pa;
    return (a.process_id ?? "").localeCompare(b.process_id ?? "");
  });

  // The Unassigned pool is dropped automatically when empty: it only enters
  // `usedPoolIds` if some node was assigned to it. Process pools always have
  // ≥1 member by construction (an Action becomes a process only when a child
  // points at it). No extra filtering needed here.

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
  const KIND_ORDER: Record<ProcessLaneKind, number> = {
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

  return limitProcessGraph({ pools, lanes, nodes, links }, opts.nodeLimit, opts.focusId);
}

function limitProcessGraph(
  graph: ProcessGraphData,
  nodeLimit: number | undefined,
  focusId: string | undefined,
): ProcessGraphData {
  if (!nodeLimit || graph.nodes.length <= nodeLimit) return graph;

  const limit = Math.max(1, Math.floor(nodeLimit));
  const selected = selectProcessNodeIds(graph.nodes, graph.links, limit, focusId);
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = graph.links.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));
  const laneIds = new Set(nodes.map((node) => node.laneId));
  const poolIds = new Set(nodes.map((node) => node.pool_id));
  const lanes = graph.lanes.filter((lane) => laneIds.has(lane.id));
  const pools = graph.pools.filter((pool) => poolIds.has(pool.id));
  return { pools, lanes, nodes, links };
}

function selectProcessNodeIds(
  nodes: readonly ProcessNode[],
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

  const ordered = [...nodes].sort(compareProcessNodesForLargeDoco);
  for (const node of ordered) {
    add(node.id);
    if (selected.size >= limit) break;
  }
  return selected;
}

function compareProcessNodesForLargeDoco(a: ProcessNode, b: ProcessNode): number {
  const lifecycleDiff = lifecycleRenderRank(a.lifecycle) - lifecycleRenderRank(b.lifecycle);
  if (lifecycleDiff !== 0) return lifecycleDiff;
  const dateDiff = Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "");
  if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
  return a.id.localeCompare(b.id);
}

function sequenceFlowLabel(label: string | null, condition: string | null): string | null {
  const raw = label ?? condition;
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/\s+/g, " ");
  if (!compact) return null;
  return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function processLinkFromEdgeRow(row: EdgeRow, handle: string | undefined): OverviewGraphLink {
  const href = handle ? `/${handle}/edges/${row.id}` : null;
  const displayType = edgeRole(row);
  return {
    id: row.id,
    source: row.from_id,
    target: row.to_id,
    edge_type: displayType,
    lifecycle: row.lifecycle ?? "active",
    label: row.edge_type === "flows_to" ? sequenceFlowLabel(row.label, row.condition) : null,
    href,
  };
}

export function computeNearestProcessByNode(
  processIds: readonly string[],
  links: readonly OverviewGraphLink[],
  ranks: ReadonlyMap<string, number>,
): Map<string, string> {
  const uniqueProcessIds = Array.from(new Set(processIds));
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

  const orderedProcesses = uniqueProcessIds.sort((a, b) => {
    const rankDiff = (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });
  const nearest = new Map<string, string>();
  const queue: string[] = [];
  for (const processId of orderedProcesses) {
    nearest.set(processId, processId);
    queue.push(processId);
  }

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const currentProcess = nearest.get(current);
    if (!currentProcess) continue;
    const neighbors = Array.from(adjacency.get(current) ?? []).sort();
    for (const neighbor of neighbors) {
      if (nearest.has(neighbor)) continue;
      nearest.set(neighbor, currentProcess);
      queue.push(neighbor);
    }
  }

  return nearest;
}

type OutgoingEdgesByType = Map<string, Map<string, EdgeRow[]>>;

function nodeTypeOf(id: string): string {
  const i = id.indexOf("_");
  return i <= 0 ? "" : id.slice(0, i);
}

// Edge `role` is retired, so the BPMN key a node groups its outgoing edges by
// is DERIVED from the edge type and its endpoint node types — recovering the old
// role meaning structurally: a flow node's `supports` → Intent is "serves"; an
// Action's `attributed_to` → Principal is its performer, a gateway Decision's is
// its decider, an Intent's is its owner; a `constrained_by` → Rule is "gated_by".
// Everything else keys on the bare edge type.
function edgeRole(edge: EdgeRow): string {
  const from = nodeTypeOf(edge.from_id);
  const to = nodeTypeOf(edge.to_id);
  if (edge.edge_type === "supports" && to === "intent") return "serves";
  if (edge.edge_type === "attributed_to" && to === "principal") {
    if (from === "action") return "performed_by";
    if (from === "decision") return "decided_by";
    if (from === "intent") return "owned_by";
  }
  if (edge.edge_type === "constrained_by" && to === "rule") return "gated_by";
  return edge.edge_type;
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
  // Single-valued role lookup (lane attribution, eval host): a retired edge is
  // a PAST link, not the current one. When a node carries both a live and a
  // retired edge for the same role — e.g. a Decision re-attributed from one
  // Principal to another — the live edge wins, so the node lands in the
  // current performer's lane rather than the old one. Fall back to a retired
  // target only when every edge for the role is retired (a fully-retired
  // process still needs its lane).
  const edges = outgoing.get(fromId)?.get(edgeType) ?? [];
  const live = edges.find((edge) => edge.lifecycle !== "retired");
  return (live ?? edges[0])?.to_id ?? null;
}

function laneReferenceFor(
  nodeType: string,
  rowId: string,
  outgoing: OutgoingEdgesByType,
  userById: Map<string, UserRow>,
): string | null {
  switch (nodeType) {
    case "action":
    case "log":
      return firstEdgeTarget(outgoing, rowId, "performed_by");
    case "decision": {
      // Prefer the decision's own `decided_by` decider, but fall back to a
      // `performed_by` actor so a Decision attributed with the activity role
      // (as Señor Doco and legacy imports sometimes emit) still resolves to a
      // lane instead of "Unassigned".
      const ref =
        firstEdgeTarget(outgoing, rowId, "decided_by") ??
        firstEdgeTarget(outgoing, rowId, "performed_by");
      if (!ref) return null;
      if (ref.startsWith("user_")) {
        const collab = userById.get(ref);
        return collab?.github_login ?? null;
      }
      return ref;
    }
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
  if (row.node_type === "rule") {
    for (const candidate of allRows) {
      if (candidate.node_type !== "action") continue;
      const gatedBy = edgeTargets(outgoing, candidate.id, "gated_by");
      if (!gatedBy.includes(row.id)) continue;
      const ref = laneReferenceFor("action", candidate.id, outgoing, userById);
      const resolved = resolveLane(ref, principalById, principalByName);
      if (resolved.id.startsWith("principal_")) return resolved;
      return null;
    }
    return null;
  }
  if (row.node_type === "eval") {
    const targetRef = firstEdgeTarget(outgoing, row.id, "tests");
    if (!targetRef) return null;
    const target = allRows.find((r) => r.id === targetRef);
    if (!target) return null;
    const ref = laneReferenceFor(target.node_type, target.id, outgoing, userById);
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
  nodes: readonly ProcessNode[],
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
    if (node.node_type === "action" && depth < entry.firstActionDepth) {
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
