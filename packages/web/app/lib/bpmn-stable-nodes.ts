// Preserve React-Flow node object identity across re-renders so that
// `React.memo`'d node components can skip work.
//
// The BPMN layout re-runs whenever focus changes (depth-based opacity,
// the focal node's heavier border, etc.). That hands `flowNodes` a fresh
// set of node objects every time — even for nodes far from the focus
// whose rendered output is byte-for-byte identical. Without identity
// reuse, React Flow re-renders all of them on every focus click.
//
// `reuseStableNodes` compares each freshly-built node against the one
// emitted last render and, when their render inputs match, returns the
// *previous* object so its identity is preserved. Equality is strict:
// any uncertainty falls back to the new object (a harmless extra
// re-render), never a stale one.

interface StabilizableNode {
  id: string;
  type?: string;
  parentId?: string;
  className?: string;
  hidden?: boolean;
  zIndex?: number;
  draggable?: boolean;
  selectable?: boolean;
  connectable?: boolean;
  position: { x: number; y: number };
  // `object` (not `Record<string, unknown>`) so React Flow's
  // `style?: CSSProperties` and typed `data` satisfy the constraint.
  style?: object;
  data?: object;
}

function shallowEqualRecord(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keysA = Object.keys(ra);
  const keysB = Object.keys(rb);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.is(ra[key], rb[key])) return false;
  }
  return true;
}

/**
 * True when two nodes would render identically. `position`, `style`, and
 * `data` are always freshly-allocated objects on each layout pass, so we
 * compare their *contents* one level deep rather than by identity. The
 * values inside `data` are primitives or stable upstream references (the
 * source entity, callbacks), so a shallow comparison is exact here.
 */
export function sameFlowNode(a: StabilizableNode, b: StabilizableNode): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.parentId === b.parentId &&
    a.className === b.className &&
    a.hidden === b.hidden &&
    a.zIndex === b.zIndex &&
    a.draggable === b.draggable &&
    a.selectable === b.selectable &&
    a.connectable === b.connectable &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    shallowEqualRecord(a.style, b.style) &&
    shallowEqualRecord(a.data, b.data)
  );
}

export function indexById<T extends { id: string }>(nodes: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const node of nodes) map.set(node.id, node);
  return map;
}

/**
 * Return `next` with the object identity of any node whose render inputs
 * are unchanged swapped back to the matching `prev` node. Order and
 * length match `next` exactly.
 */
export function reuseStableNodes<T extends StabilizableNode>(
  next: readonly T[],
  prevById: ReadonlyMap<string, T>,
): T[] {
  return next.map((node) => {
    const prev = prevById.get(node.id);
    return prev && sameFlowNode(prev, node) ? prev : node;
  });
}
