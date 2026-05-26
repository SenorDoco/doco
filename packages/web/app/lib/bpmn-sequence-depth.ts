interface SequenceDepthNode {
  id: string;
  created_at?: string | null;
  bfs_depth?: number;
}

interface SequenceDepthLink {
  source: string;
  target: string;
  synapse_type: string;
}

const SEQUENCE_FLOW_SYNAPSES: ReadonlySet<string> = new Set(["sequence_flow"]);

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
    if (!SEQUENCE_FLOW_SYNAPSES.has(link.synapse_type)) continue;
    sequenceLinks.push({
      source: link.source,
      target: link.target,
      synapse_type: link.synapse_type,
    });
  }

  const componentByNode = computeStrongComponents(nodeIds, sequenceLinks);
  const predecessorByNode = new Map<string, string[]>();
  for (const id of nodeIds) predecessorByNode.set(id, []);

  for (const link of sequenceLinks) {
    const sameComponent = componentByNode.get(link.source) === componentByNode.get(link.target);
    if (sameComponent && compareNaturalOrder(link.target, link.source, nodeById, depthFloor) <= 0) {
      continue;
    }
    predecessorByNode.get(link.target)?.push(link.source);
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
