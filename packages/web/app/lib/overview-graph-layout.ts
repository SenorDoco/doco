import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { FAR_DEPTH, computeDepthFromCenter, depthBucket } from "./graph-depth";

export interface OverviewLayoutNode {
  id: string;
  entity_type: string;
}

export interface OverviewLayoutLink {
  source: string;
  target: string;
  edge_type?: string | null;
}

export interface Point {
  x: number;
  y: number;
}

const NODE_TYPE_ORDER = new Map(
  [
    "principal",
    "intent",
    "decision",
    "action",
    "rule",
    "guidance_policy",
    "node_authoring_policy",
    "log",
    "eval",
    "reference",
    "idea",
    "state",
  ].map((type, index) => [type, index]),
);

const NODE_WIDTH = 224;
const NODE_HEIGHT = 91;
const COLLISION_PADDING = 48;
const TARGET_AVERAGE_RADIUS = 360;
const SMALL_GRAPH_COMPACT_NODE_LIMIT = 8;
const DISCONNECTED_COMPONENT_RADIUS = 620;
const DISCONNECTED_COMPONENT_SIZE_SPACING = 24;
const COMPACT_DISCONNECTED_COMPONENT_RADIUS = 280;
const COMPACT_DISCONNECTED_COMPONENT_SIZE_SPACING = 8;

const EDGE_LAYOUT_WEIGHT = new Map<string, number>([
  ["sequence_flow", 2.4],
  ["reports_to", 2.1],
  ["serves", 1.8],
  ["enacts", 1.7],
  ["gated_by", 1.6],
  ["tests", 1.5],
  ["performed_by", 1.5],
  ["owned_by", 1.4],
  ["acts_on", 1.4],
  ["source_ref", 1.25],
] as const);

/**
 * Lay out `others` in a ring at `radius` around `center`, sorted by
 * entity type then id so the placement is stable across renders.
 */
function placeRing(
  positions: Map<string, Point>,
  others: OverviewLayoutNode[],
  center: Point,
  radius: number,
  startAngle: number,
) {
  if (others.length === 0) return;
  others.sort((a, b) => {
    const ai = NODE_TYPE_ORDER.get(a.entity_type) ?? 999;
    const bi = NODE_TYPE_ORDER.get(b.entity_type) ?? 999;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
  others.forEach((node, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / others.length;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
}

/**
 * Single-ring layout — every non-focal node goes on the same ring,
 * sorted by type then id. Retained for tiny/linkless fallback paths
 * where a force layout cannot express relevance.
 */
export function singleRingLayout(
  nodes: readonly OverviewLayoutNode[],
  centerId: string,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const center: Point = { x: 0, y: 0 };
  const others: OverviewLayoutNode[] = [];
  let hasCenter = false;
  for (const node of nodes) {
    if (node.id === centerId) {
      positions.set(node.id, center);
      hasCenter = true;
    } else {
      others.push(node);
    }
  }

  if (others.length === 0) {
    if (!hasCenter) {
      const first = nodes[0];
      if (first) positions.set(first.id, center);
    }
    return positions;
  }

  const radius = Math.max(220, others.length * 18);
  placeRing(positions, others, center, radius, -Math.PI / 2);
  return positions;
}

/**
 * Depth-aware concentric-ring layout retained as a fallback for tiny or
 * linkless render windows. Force layouts need links to express relevance;
 * without them, the old deterministic neighbourhood rings are more
 * legible than arbitrary scatter.
 */
export function depthRingLayout(
  nodes: readonly OverviewLayoutNode[],
  links: readonly OverviewLayoutLink[],
  centerId: string,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const center: Point = { x: 0, y: 0 };
  let hasCenter = false;
  for (const node of nodes) {
    if (node.id === centerId) {
      positions.set(node.id, center);
      hasCenter = true;
    }
  }

  if (!hasCenter) {
    return singleRingLayout(nodes, centerId);
  }

  const depths = computeDepthFromCenter([...nodes], [...links], centerId);
  const byBucket = new Map<number, OverviewLayoutNode[]>();
  for (const node of nodes) {
    if (node.id === centerId) continue;
    const bucket = depthBucket(depths.get(node.id));
    const list = byBucket.get(bucket) ?? [];
    list.push(node);
    byBucket.set(bucket, list);
  }

  const BASE_RADIUS = 220;
  const RING_SPACING = 180;
  for (let bucket = 1; bucket <= FAR_DEPTH; bucket++) {
    const ring = byBucket.get(bucket);
    if (!ring || ring.length === 0) continue;
    const baseRadius = BASE_RADIUS + (bucket - 1) * RING_SPACING;
    const radius = Math.max(baseRadius, ring.length * 18 + (bucket - 1) * RING_SPACING);
    const startAngle = -Math.PI / 2 + (bucket % 2 === 0 ? Math.PI / ring.length : 0);
    placeRing(positions, ring, center, radius, startAngle);
  }

  return positions;
}

function graphLinkCount(
  nodes: readonly OverviewLayoutNode[],
  links: readonly OverviewLayoutLink[],
): number {
  const ids = new Set(nodes.map((node) => node.id));
  let count = 0;
  for (const link of links) {
    if (link.source === link.target) continue;
    if (ids.has(link.source) && ids.has(link.target)) count++;
  }
  return count;
}

function connectedComponents(
  nodes: readonly OverviewLayoutNode[],
  links: readonly OverviewLayoutLink[],
): string[][] {
  const ids = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const link of links) {
    if (link.source === link.target) continue;
    if (!ids.has(link.source) || !ids.has(link.target)) continue;
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }

  const components: string[][] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const component: string[] = [];
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      component.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    component.sort();
    components.push(component);
  }

  return components.sort((a, b) => {
    const sizeDiff = b.length - a.length;
    if (sizeDiff !== 0) return sizeDiff;
    return (a[0] ?? "").localeCompare(b[0] ?? "");
  });
}

function layoutWeight(link: OverviewLayoutLink, centerId: string): number {
  const base = EDGE_LAYOUT_WEIGHT.get(link.edge_type ?? "") ?? 1;
  const touchesCenter = link.source === centerId || link.target === centerId;
  return touchesCenter ? base * 1.15 : base;
}

function averageRadius(positions: Map<string, Point>, centerId: string): number {
  const center = positions.get(centerId) ?? { x: 0, y: 0 };
  let total = 0;
  let count = 0;
  for (const [id, position] of positions.entries()) {
    if (id === centerId) continue;
    total += Math.hypot(position.x - center.x, position.y - center.y);
    count++;
  }
  return count > 0 ? total / count : 0;
}

function normalizeAroundFocus(
  positions: Map<string, Point>,
  nodes: readonly OverviewLayoutNode[],
  centerId: string,
): Map<string, Point> {
  const anchor =
    positions.get(centerId) ??
    (() => {
      let x = 0;
      let y = 0;
      for (const position of positions.values()) {
        x += position.x;
        y += position.y;
      }
      return positions.size > 0 ? { x: x / positions.size, y: y / positions.size } : { x: 0, y: 0 };
    })();

  const centered = new Map<string, Point>();
  for (const node of nodes) {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    centered.set(node.id, {
      x: position.x - anchor.x,
      y: position.y - anchor.y,
    });
  }

  const radius = averageRadius(centered, centerId);
  if (radius <= 0) return centered;

  const desiredRadius = TARGET_AVERAGE_RADIUS + Math.min(nodes.length, 40) * 4;
  const scale = Math.max(0.2, Math.min(7, desiredRadius / radius));
  for (const [id, position] of centered.entries()) {
    centered.set(id, { x: position.x * scale, y: position.y * scale });
  }
  return centered;
}

function separateDisconnectedComponents(
  positions: Map<string, Point>,
  nodes: readonly OverviewLayoutNode[],
  links: readonly OverviewLayoutLink[],
  centerId: string,
): Map<string, Point> {
  const components = connectedComponents(nodes, links);
  if (components.length <= 1) return positions;

  const next = new Map(positions);
  const focusComponentIndex = components.findIndex((component) => component.includes(centerId));
  if (focusComponentIndex > 0) {
    const [focusComponent] = components.splice(focusComponentIndex, 1);
    if (focusComponent) components.unshift(focusComponent);
  }

  components.forEach((component, index) => {
    let cx = 0;
    let cy = 0;
    let count = 0;
    for (const id of component) {
      const position = next.get(id);
      if (!position) continue;
      cx += position.x;
      cy += position.y;
      count++;
    }
    if (count === 0) return;
    cx /= count;
    cy /= count;

    const target =
      index === 0
        ? { x: 0, y: 0 }
        : (() => {
            const angle =
              -Math.PI / 2 + (Math.PI * 2 * (index - 1)) / Math.max(1, components.length - 1);
            const compact = nodes.length <= SMALL_GRAPH_COMPACT_NODE_LIMIT;
            const radius =
              (compact ? COMPACT_DISCONNECTED_COMPONENT_RADIUS : DISCONNECTED_COMPONENT_RADIUS) +
              Math.min(component.length, 12) *
                (compact
                  ? COMPACT_DISCONNECTED_COMPONENT_SIZE_SPACING
                  : DISCONNECTED_COMPONENT_SIZE_SPACING);
            return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
          })();

    for (const id of component) {
      const position = next.get(id);
      if (!position) continue;
      next.set(id, {
        x: position.x + target.x - cx,
        y: position.y + target.y - cy,
      });
    }
  });

  return next;
}

function relaxCardCollisions(
  positions: Map<string, Point>,
  nodes: readonly OverviewLayoutNode[],
  centerId: string,
): Map<string, Point> {
  const next = new Map(positions);
  const minX = NODE_WIDTH + COLLISION_PADDING;
  const minY = NODE_HEIGHT + COLLISION_PADDING;

  for (let iteration = 0; iteration < 10; iteration++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (!a || !b) continue;
        const pa = next.get(a.id);
        const pb = next.get(b.id);
        if (!pa || !pb) continue;

        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const overlapX = minX - Math.abs(dx);
        const overlapY = minY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        const signX = dx === 0 ? (a.id < b.id ? 1 : -1) : Math.sign(dx);
        const signY = dy === 0 ? (a.id < b.id ? 1 : -1) : Math.sign(dy);
        const moveX = overlapX < overlapY;
        const amount = (moveX ? overlapX : overlapY) / 2 + 1;
        const ax = moveX ? -signX * amount : 0;
        const ay = moveX ? 0 : -signY * amount;
        const bx = -ax;
        const by = -ay;

        if (a.id !== centerId) next.set(a.id, { x: pa.x + ax, y: pa.y + ay });
        if (b.id !== centerId) next.set(b.id, { x: pb.x + bx, y: pb.y + by });
        moved = true;
      }
    }
    if (!moved) break;
  }

  const focus = next.get(centerId);
  if (!focus) return next;
  for (const [id, position] of next.entries()) {
    next.set(id, { x: position.x - focus.x, y: position.y - focus.y });
  }
  return next;
}

export function clusteredForceLayout(
  nodes: readonly OverviewLayoutNode[],
  links: readonly OverviewLayoutLink[],
  centerId: string,
): Map<string, Point> {
  const linkCount = graphLinkCount(nodes, links);
  if (nodes.length < 3) {
    return depthRingLayout(nodes, links, centerId);
  }
  if (linkCount === 0) return singleRingLayout(nodes, centerId);

  const graph = new Graph({ type: "undirected", multi: true, allowSelfLoops: false });
  const seed = depthRingLayout(nodes, links, centerId);
  for (const node of nodes) {
    const position = seed.get(node.id) ?? { x: 0, y: 0 };
    graph.addNode(node.id, {
      x: position.x / 100,
      y: position.y / 100,
      size: 10,
    });
  }

  const ids = new Set(nodes.map((node) => node.id));
  links.forEach((link, index) => {
    if (link.source === link.target) return;
    if (!ids.has(link.source) || !ids.has(link.target)) return;
    graph.addUndirectedEdgeWithKey(
      `${link.source}:${link.target}:${index}`,
      link.source,
      link.target,
      {
        weight: layoutWeight(link, centerId),
      },
    );
  });

  const positions = forceAtlas2(graph, {
    iterations: Math.max(80, Math.min(180, nodes.length * 6)),
    getEdgeWeight: "weight",
    settings: {
      ...forceAtlas2.inferSettings(graph),
      linLogMode: true,
      edgeWeightInfluence: 1.4,
      scalingRatio: 6,
      gravity: 0.08,
      strongGravityMode: true,
      slowDown: 2 + Math.log(nodes.length),
      barnesHutOptimize: nodes.length > 120,
    },
  });

  const raw = new Map<string, Point>();
  for (const node of nodes) {
    const position = positions[node.id];
    raw.set(
      node.id,
      position ? { x: position.x, y: position.y } : (seed.get(node.id) ?? { x: 0, y: 0 }),
    );
  }

  const centered = normalizeAroundFocus(raw, nodes, centerId);
  const separated = separateDisconnectedComponents(centered, nodes, links, centerId);
  return relaxCardCollisions(separated, nodes, centerId);
}

export function layoutOverviewGraphNodes(
  nodes: readonly OverviewLayoutNode[],
  links: readonly OverviewLayoutLink[],
  centerId: string,
): Map<string, Point> {
  return clusteredForceLayout(nodes, links, centerId);
}
