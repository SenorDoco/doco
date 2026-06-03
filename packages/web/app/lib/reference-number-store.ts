// A tiny external store for per-node reference numbers (#N badges).
//
// Why this exists: a React-Flow perspective recomputes its reference
// numbering on every pan/zoom frame (the numbers reflect on-screen
// reading order). If that number lives inside each node's `data`, the
// whole `nodes` array has to be rebuilt every frame and React Flow
// re-renders every node — sluggish even at a few dozen nodes.
//
// Routing the numbers through this store instead lets each badge
// subscribe to *its own* number via `useReferenceNumber`. The node
// objects handed to React Flow no longer carry the number, so the
// `nodes` array stays referentially stable across pans, and only the
// handful of badges whose number actually changed re-render — the node
// shapes themselves (borders, handles, SVG) stay put.

import { createContext, useContext, useSyncExternalStore } from "react";

type Listener = () => void;

export interface ReferenceNumberStore {
  /** Replace the full id→number map. No-op (no notify) if value-equal. */
  setNumbers(next: ReadonlyMap<string, number>): void;
  /** Current number for an id, or undefined when it has none. */
  getNumber(id: string): number | undefined;
  /** Subscribe to any change; returns an unsubscribe fn. */
  subscribe(listener: Listener): () => void;
}

function sameNumbers(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, n] of a) {
    if (b.get(id) !== n) return false;
  }
  return true;
}

export function createReferenceNumberStore(
  initial?: ReadonlyMap<string, number>,
): ReferenceNumberStore {
  let numbers: ReadonlyMap<string, number> = initial ?? new Map();
  const listeners = new Set<Listener>();
  return {
    setNumbers(next) {
      if (sameNumbers(numbers, next)) return;
      numbers = next;
      for (const listener of listeners) listener();
    },
    getNumber(id) {
      return numbers.get(id);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const ReferenceNumberStoreContext = createContext<ReferenceNumberStore | null>(null);

const noopSubscribe: ReferenceNumberStore["subscribe"] = () => () => {};

/**
 * Subscribe to the reference number for a single id. Re-renders the
 * calling component only when *that id's* number changes — not when any
 * other node's number changes — because `useSyncExternalStore` bails out
 * on an `Object.is`-equal snapshot. Returns undefined outside a provider.
 */
export function useReferenceNumber(id: string): number | undefined {
  const store = useContext(ReferenceNumberStoreContext);
  const subscribe = store ? store.subscribe : noopSubscribe;
  const getSnapshot = () => store?.getNumber(id);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
