import { useEffect, useRef, useState } from "react";

/**
 * Track which node IDs in `nodeIds` arrived via a live refresh (versus
 * being present at first mount). The graph routes poll on a 5s interval
 * (ADR-089); this hook diffs each refresh's IDs against what was seen
 * before so the renderer can draw a "this is new" halo on freshly
 * arrived nodes.
 *
 * The first effect run treats every id as already seen — landing on a
 * graph page shouldn't fire glows for nodes that were already there.
 * Subsequent runs flag any id missing from the seen set as new and
 * schedule a timer to drop the flag after `windowMs`.
 */
export function useNewNodeIds(nodeIds: readonly string[], windowMs = 60_000): Set<string> {
  const seenRef = useRef<Set<string> | null>(null);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (seenRef.current === null) {
      seenRef.current = new Set(nodeIds);
      return;
    }
    const seen = seenRef.current;
    const newlyAdded: string[] = [];
    for (const id of nodeIds) {
      if (!seen.has(id)) {
        seen.add(id);
        newlyAdded.push(id);
      }
    }
    if (newlyAdded.length === 0) return;
    setNewIds((prev) => {
      const next = new Set(prev);
      for (const id of newlyAdded) next.add(id);
      return next;
    });
    for (const id of newlyAdded) {
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setNewIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, windowMs);
      timersRef.current.set(id, timer);
    }
  }, [nodeIds, windowMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return newIds;
}
