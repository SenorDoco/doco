/**
 * Cross-pool sequence-flow neighbours for the BPMN process perspective.
 *
 * When a process renders as a pool we draw not only its member nodes but also
 * the nodes in OTHER pools that connect to it through sequence flow
 * (`flows_to`) — as normal boxes OUTSIDE the focal pool: to the LEFT when they
 * flow INTO the pool (an entry), to the RIGHT when the pool flows OUT to them
 * (an exit). Each box stands in for a node in another process; clicking it
 * focuses that node, which renders its own (different) pool.
 *
 * Pure (no React / React Flow) so it unit-tests cleanly and stays in lockstep
 * with the renderer.
 */

interface BoundaryNode {
  id: string;
  pool_id: string;
}

interface BoundaryLink {
  source: string;
  target: string;
  edge_type: string;
  /** The arrow's branch condition, if any (e.g. "Yes"). Carried so a
   *  cross-pool boundary arrow can show the same tag it would in-pool. */
  label?: string | null;
}

const SEQUENCE_FLOW_EDGES: ReadonlySet<string> = new Set(["flows_to"]);

// The hierarchy edge: a flow node points at its parent process Action through
// `has_parent`. Unlike `flows_to` (sequence, drawn left↔right), this is
// containment, drawn top↕down — the parent sits ABOVE the child's pool.
const HAS_PARENT_EDGE = "has_parent";

/**
 * Where a cross-pool `flows_to` neighbour's connecting arrow attaches inside the
 * focal pool:
 *   - `title` — the edge touches the pool's own process Action (the container),
 *     so it attaches to the pool's title band.
 *   - `node`  — the edge touches an inner member, so it draws node-to-node.
 */
export type ExternalAttach = { kind: "title"; poolId: string } | { kind: "node"; nodeId: string };

/**
 * A node in ANOTHER pool that connects to the focal pool through sequence flow.
 * Rendered as a normal box OUTSIDE the focal pool — to the LEFT when it flows
 * INTO the pool (`entry`), to the RIGHT when the pool flows OUT to it (`exit`).
 */
export interface ExternalNeighbour {
  /** The external node to draw. */
  id: string;
  direction: "entry" | "exit";
  attach: ExternalAttach;
  /** The connecting sequence-flow edge's type and condition, so the boundary
   *  arrow renders the same tag an in-pool arrow would (its type, or the
   *  branch condition when one is set). */
  edgeType: string;
  label: string | null;
}

/**
 * Classify the focal pool's cross-boundary `flows_to` neighbours. A focal pool
 * `pool:<actionId>` is "owned" by the process Action `<actionId>`, so an edge
 * touching that Action attaches to the title; an edge touching a member attaches
 * to that member. The external endpoint must be a known node (so we can render
 * its box); the in-pool endpoint may be the process Action even if it isn't
 * itself drawn as a member.
 */
export function computeExternalNeighbours(
  focalPoolIds: ReadonlySet<string>,
  nodes: readonly BoundaryNode[],
  links: readonly BoundaryLink[],
): ExternalNeighbour[] {
  const poolByNode = new Map(nodes.map((node) => [node.id, node.pool_id]));
  const isPoolAction = (id: string): boolean => focalPoolIds.has(`pool:${id}`);
  const memberInFocus = (id: string): boolean => {
    const pool = poolByNode.get(id);
    return pool !== undefined && focalPoolIds.has(pool);
  };
  const inFocus = (id: string): boolean => memberInFocus(id) || isPoolAction(id);
  const attachFor = (id: string): ExternalAttach =>
    isPoolAction(id) ? { kind: "title", poolId: `pool:${id}` } : { kind: "node", nodeId: id };

  const seen = new Set<string>();
  const out: ExternalNeighbour[] = [];
  const add = (
    id: string,
    direction: "entry" | "exit",
    attach: ExternalAttach,
    link: BoundaryLink,
  ) => {
    const key = `${direction} ${id} ${attach.kind === "title" ? attach.poolId : attach.nodeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, direction, attach, edgeType: link.edge_type, label: link.label ?? null });
  };

  for (const link of links) {
    if (!SEQUENCE_FLOW_EDGES.has(link.edge_type)) continue;
    const sourceIn = inFocus(link.source);
    const targetIn = inFocus(link.target);
    // Skip an internal edge, or one between two out-of-pool nodes.
    if (sourceIn === targetIn) continue;
    // The in-pool endpoint anchors the arrow; the other is the external box.
    const external = sourceIn ? link.target : link.source;
    if (!poolByNode.has(external)) continue; // can't render an unknown external
    if (sourceIn) add(external, "exit", attachFor(link.source), link);
    else add(external, "entry", attachFor(link.target), link);
  }

  return out.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === "entry" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * A parent process the focal pool hangs under. A pool `pool:<actionId>` is
 * "owned" by the process Action `<actionId>`; that Action can point at one or
 * more parent Actions through `has_parent` edges — an Action can belong to
 * several processes at once. Each parent is itself a process pool
 * (`pool:<id>`), drawn from the TOP of the focal pool toward the left so the
 * hierarchy reads top-down; clicking one drills into that parent's pool.
 */
export interface ParentProcess {
  /** The focal pool this parent sits above (`pool:<actionId>`). */
  poolId: string;
  /** The parent process Action's id; its own pool is `pool:<id>`. */
  id: string;
  /** The hierarchy edge's type (`has_parent`), carried so the rising arrow
   *  shows its tag like every other process arrow. */
  edgeType: string;
}

/**
 * The parent processes of each focal pool's process Action, gathered from the
 * `has_parent` edges leaving that Action. Every parent is reported — a single
 * Action that belongs to multiple processes yields one entry per parent —
 * de-duplicated and sorted (by focal pool, then parent id) so the render order
 * is stable.
 */
export function computeParentProcesses(
  focalPoolIds: ReadonlySet<string>,
  links: readonly BoundaryLink[],
): ParentProcess[] {
  const seen = new Set<string>();
  const out: ParentProcess[] = [];
  for (const link of links) {
    if (link.edge_type !== HAS_PARENT_EDGE) continue;
    const poolId = `pool:${link.source}`;
    if (!focalPoolIds.has(poolId)) continue;
    const key = `${poolId} ${link.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ poolId, id: link.target, edgeType: HAS_PARENT_EDGE });
  }
  return out.sort((a, b) => {
    if (a.poolId !== b.poolId) return a.poolId.localeCompare(b.poolId);
    return a.id.localeCompare(b.id);
  });
}
