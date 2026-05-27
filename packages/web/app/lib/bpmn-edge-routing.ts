export interface BpmnEdgePoint {
  x: number;
  y: number;
}

export interface BpmnEdgeBox {
  id: string;
  laneId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface BpmnLaneBand {
  id: string;
  top: number;
  bottom: number;
}

export interface BpmnEdgeRouteInput {
  source: BpmnEdgeBox;
  target: BpmnEdgeBox;
  obstacles: readonly BpmnEdgeBox[];
  lanes: ReadonlyMap<string, BpmnLaneBand>;
  edgeIndex?: number;
}

const PORT_GAP = 18;
const NODE_CLEARANCE = 10;
const SCAN_STEP = 24;
const MAX_SCAN_STEPS = 14;

export function routeBpmnSequenceEdge({
  source,
  target,
  obstacles,
  lanes,
  edgeIndex = 0,
}: BpmnEdgeRouteInput): BpmnEdgePoint[] {
  const sourceCenterY = centerY(source);
  const targetCenterY = centerY(target);
  const sourceExitX = source.right + PORT_GAP;
  const targetEntryX = target.left - PORT_GAP;
  const sourceLane = lanes.get(source.laneId);
  const targetLane = lanes.get(target.laneId);
  const sourceCorridorY = laneCorridorY(source, sourceLane, edgeIndex);
  const targetCorridorY = laneCorridorY(target, targetLane, edgeIndex + 1);
  const transferX = chooseVerticalTransferX({
    source,
    target,
    obstacles,
    y1: sourceCorridorY,
    y2: targetCorridorY,
    edgeIndex,
  });

  return compactPoints([
    { x: source.right, y: sourceCenterY },
    { x: sourceExitX, y: sourceCenterY },
    { x: sourceExitX, y: sourceCorridorY },
    { x: transferX, y: sourceCorridorY },
    { x: transferX, y: targetCorridorY },
    { x: targetEntryX, y: targetCorridorY },
    { x: targetEntryX, y: targetCenterY },
    { x: target.left, y: targetCenterY },
  ]);
}

export function bpmnEdgePath(points: readonly BpmnEdgePoint[], radius = 8): string {
  const clean = compactPoints(points);
  if (clean.length === 0) return "";
  if (clean.length === 1) return `M ${fmt(clean[0].x)} ${fmt(clean[0].y)}`;

  let d = `M ${fmt(clean[0].x)} ${fmt(clean[0].y)}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1];
    const current = clean[i];
    const next = clean[i + 1];
    const inLen = distance(prev, current);
    const outLen = distance(current, next);
    if (inLen === 0 || outLen === 0 || isStraight(prev, current, next)) {
      d += ` L ${fmt(current.x)} ${fmt(current.y)}`;
      continue;
    }
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const before = pointToward(current, prev, r);
    const after = pointToward(current, next, r);
    d += ` L ${fmt(before.x)} ${fmt(before.y)}`;
    d += ` Q ${fmt(current.x)} ${fmt(current.y)} ${fmt(after.x)} ${fmt(after.y)}`;
  }
  const last = clean[clean.length - 1];
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

function chooseVerticalTransferX({
  source,
  target,
  obstacles,
  y1,
  y2,
  edgeIndex,
}: {
  source: BpmnEdgeBox;
  target: BpmnEdgeBox;
  obstacles: readonly BpmnEdgeBox[];
  y1: number;
  y2: number;
  edgeIndex: number;
}): number {
  const targetIsRight = target.left >= source.right;
  const candidateXs: number[] = [];
  const jitter = ((edgeIndex % 5) - 2) * 5;

  if (targetIsRight) {
    const min = source.right + PORT_GAP;
    const max = target.left - PORT_GAP;
    if (max > min) {
      const middle = (min + max) / 2 + jitter;
      candidateXs.push(middle, min, max);
      for (let step = 1; step <= MAX_SCAN_STEPS; step++) {
        candidateXs.push(middle - step * SCAN_STEP, middle + step * SCAN_STEP);
      }
    }
  }

  const outsideRight = Math.max(source.right, target.right, ...obstacles.map((box) => box.right));
  const outsideLeft = Math.min(source.left, target.left, ...obstacles.map((box) => box.left));
  for (let step = 0; step <= 4; step++) {
    const offset = PORT_GAP + step * SCAN_STEP + Math.max(0, jitter);
    candidateXs.push(outsideRight + offset);
  }
  for (let step = 0; step <= 2; step++) {
    candidateXs.push(outsideLeft - PORT_GAP - step * SCAN_STEP);
  }

  for (const x of candidateXs) {
    if (isVerticalClear(x, y1, y2, obstacles, source.id, target.id)) return x;
  }
  return outsideRight + PORT_GAP;
}

function laneCorridorY(
  box: BpmnEdgeBox,
  lane: BpmnLaneBand | undefined,
  edgeIndex: number,
): number {
  if (!lane) return box.top - PORT_GAP;
  const topGap = Math.max(0, box.top - lane.top);
  const bottomGap = Math.max(0, lane.bottom - box.bottom);
  const jitter = (edgeIndex % 3) * 4;
  if (topGap >= 10 || topGap >= bottomGap) {
    return lane.top + clamp(8 + jitter, 6, Math.max(6, topGap - 4));
  }
  return lane.bottom - clamp(8 + jitter, 6, Math.max(6, bottomGap - 4));
}

function isVerticalClear(
  x: number,
  y1: number,
  y2: number,
  obstacles: readonly BpmnEdgeBox[],
  sourceId: string,
  targetId: string,
): boolean {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  if (bottom - top < 1) return true;
  return !obstacles.some((box) => {
    if (box.id === sourceId || box.id === targetId) return false;
    return (
      x >= box.left - NODE_CLEARANCE &&
      x <= box.right + NODE_CLEARANCE &&
      bottom >= box.top - NODE_CLEARANCE &&
      top <= box.bottom + NODE_CLEARANCE
    );
  });
}

function compactPoints(points: readonly BpmnEdgePoint[]): BpmnEdgePoint[] {
  const deduped: BpmnEdgePoint[] = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (prev && nearlyEqual(prev.x, point.x) && nearlyEqual(prev.y, point.y)) continue;
    deduped.push(point);
  }
  const compacted: BpmnEdgePoint[] = [];
  for (const point of deduped) {
    const a = compacted[compacted.length - 2];
    const b = compacted[compacted.length - 1];
    if (a && b && isStraight(a, b, point)) {
      compacted[compacted.length - 1] = point;
    } else {
      compacted.push(point);
    }
  }
  return compacted;
}

function isStraight(a: BpmnEdgePoint, b: BpmnEdgePoint, c: BpmnEdgePoint): boolean {
  return (
    (nearlyEqual(a.x, b.x) && nearlyEqual(b.x, c.x)) ||
    (nearlyEqual(a.y, b.y) && nearlyEqual(b.y, c.y))
  );
}

function pointToward(from: BpmnEdgePoint, to: BpmnEdgePoint, amount: number): BpmnEdgePoint {
  const len = distance(from, to);
  if (len === 0) return from;
  return {
    x: from.x + ((to.x - from.x) / len) * amount,
    y: from.y + ((to.y - from.y) / len) * amount,
  };
}

function distance(a: BpmnEdgePoint, b: BpmnEdgePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function centerY(box: BpmnEdgeBox): number {
  return (box.top + box.bottom) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
