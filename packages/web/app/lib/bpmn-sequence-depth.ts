interface SequenceDepthNode {
  id: string;
  created_at?: string | null;
  bfs_depth?: number;
}

interface SequenceDepthLink {
  source: string;
  target: string;
  edge_type: string;
}

const SEQUENCE_FLOW_EDGES: ReadonlySet<string> = new Set(["sequence_flow"]);

/**
 * Longest-path BPMN column depth for explicit forward sequence flow.
 *
 * A pure longest-path walk cannot handle loops: every edge in a cycle
 * cannot point right at the same time. We collapse that problem by
 * treating same-cycle edges that point back to an earlier natural
 * order as feedback edges. Those edges may still render as loopbacks,
 * but they do not pull their target left of an ordinary incoming
 * sequence edge.
 */
export function computeForwardSequenceDepths(
  nodes: readonly SequenceDepthNode[],
  links: readonly SequenceDepthLink[],
): Map<string, number> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depthFloor = new Map<string, number>();
  const sequenceLinks: SequenceDepthLink[] = [];

  for (const node of nodes) {
    const floor = node.bfs_depth;
    if (floor !== undefined && floor > 0) depthFloor.set(node.id, floor);
  }

  for (const link of links) {
    if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) continue;
    if (!SEQUENCE_FLOW_EDGES.has(link.edge_type)) continue;
    sequenceLinks.push({
      source: link.source,
      target: link.target,
      edge_type: link.edge_type,
    });
  }

  const componentByNode = computeStrongComponents(nodeIds, sequenceLinks);
  const predecessorByNode = new Map<string, string[]>();
  const successorByNode = new Map<string, string[]>();
  for (const id of nodeIds) {
    predecessorByNode.set(id, []);
    successorByNode.set(id, []);
  }
  // Nodes with at least one incoming sequence edge in the raw graph,
  // before any feedback-edge demotion. Lets us tell a genuine flow
  // source (no inbound at all) apart from a loop member whose only
  // inbound edge got demoted as a loopback.
  const hadIncomingSequenceEdge = new Set<string>();

  for (const link of sequenceLinks) {
    hadIncomingSequenceEdge.add(link.target);
    const sameComponent = componentByNode.get(link.source) === componentByNode.get(link.target);
    if (sameComponent && compareNaturalOrder(link.target, link.source, nodeById, depthFloor) <= 0) {
      continue;
    }
    predecessorByNode.get(link.target)?.push(link.source);
    successorByNode.get(link.source)?.push(link.target);
  }

  const depthByNode = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depthByNode.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return depthFloor.get(id) ?? 0;
    visiting.add(id);
    let depth = depthFloor.get(id) ?? 0;
    for (const predecessor of predecessorByNode.get(id) ?? []) {
      depth = Math.max(depth, depthOf(predecessor) + 1);
    }
    visiting.delete(id);
    depthByNode.set(id, depth);
    return depth;
  };

  for (const id of nodeIds) depthOf(id);

  // Re-anchor feedback orphans. A node whose every incoming sequence
  // edge was demoted as a loopback has no surviving predecessor, so the
  // longest-path walk parks it at column 0 — flinging a loop member to
  // the far left with a long connector reaching back to the loop. Pull
  // each such node to just left of its nearest kept successor so it
  // renders beside the loop it belongs to. A genuine source (no inbound
  // edge at all) is not in `hadIncomingSequenceEdge`, so it stays at 0.
  const isFeedbackOrphan = (id: string): boolean =>
    hadIncomingSequenceEdge.has(id) && (predecessorByNode.get(id)?.length ?? 0) === 0;

  const anchorVisiting = new Set<string>();
  const anchoredDepthOf = (id: string): number => {
    const base = depthByNode.get(id) ?? 0;
    if (!isFeedbackOrphan(id) || anchorVisiting.has(id)) return base;
    const successors = successorByNode.get(id) ?? [];
    if (successors.length === 0) return base;
    anchorVisiting.add(id);
    let nearestSuccessor = Number.POSITIVE_INFINITY;
    for (const successor of successors) {
      nearestSuccessor = Math.min(nearestSuccessor, anchoredDepthOf(successor));
    }
    anchorVisiting.delete(id);
    // Sit one column left of the nearest successor; never left of the
    // node's own longest-path floor (so we only ever pull rightward).
    return Number.isFinite(nearestSuccessor) ? Math.max(base, nearestSuccessor - 1) : base;
  };

  const anchoredDepths = new Map<string, number>();
  for (const id of nodeIds) {
    if (isFeedbackOrphan(id)) anchoredDepths.set(id, anchoredDepthOf(id));
  }
  for (const [id, depth] of anchoredDepths) depthByNode.set(id, depth);

  return depthByNode;
}

function compareNaturalOrder(
  a: string,
  b: string,
  nodeById: Map<string, SequenceDepthNode>,
  depthFloor: Map<string, number>,
): number {
  const floorDiff = (depthFloor.get(a) ?? 0) - (depthFloor.get(b) ?? 0);
  if (floorDiff !== 0) return floorDiff;

  const aTime = createdAtMs(nodeById.get(a));
  const bTime = createdAtMs(nodeById.get(b));
  if (aTime !== bTime) return aTime - bTime;

  return a.localeCompare(b);
}

function createdAtMs(node: SequenceDepthNode | undefined): number {
  if (!node?.created_at) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(node.created_at);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function computeStrongComponents(
  nodeIds: Set<string>,
  links: readonly SequenceDepthLink[],
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const link of links) outgoing.get(link.source)?.push(link.target);

  let index = 0;
  let component = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowlinkByNode = new Map<string, number>();
  const componentByNode = new Map<string, number>();

  const visit = (id: string) => {
    indexByNode.set(id, index);
    lowlinkByNode.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const next of outgoing.get(id) ?? []) {
      if (!indexByNode.has(next)) {
        visit(next);
        lowlinkByNode.set(id, Math.min(lowlinkByNode.get(id) ?? 0, lowlinkByNode.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlinkByNode.set(id, Math.min(lowlinkByNode.get(id) ?? 0, indexByNode.get(next) ?? 0));
      }
    }

    if (lowlinkByNode.get(id) !== indexByNode.get(id)) return;

    while (stack.length > 0) {
      const member = stack.pop() as string;
      onStack.delete(member);
      componentByNode.set(member, component);
      if (member === id) break;
    }
    component += 1;
  };

  for (const id of nodeIds) {
    if (!indexByNode.has(id)) visit(id);
  }
  return componentByNode;
}
