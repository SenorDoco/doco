// Lifecycle filter helpers — the canonical stage order, default
// visibility, and labelling shared by every surface that lets the user
// hide/show lifecycle stages. The filter is a page-level concern: it
// applies across every perspective (graph, list, BPMN) so switching
// tabs preserves the user's hide/show choices. Seed caller state with
// `initialVisibleLifecycles(...)` (everything except retired, which
// hides out of the box).

/**
 * Canonical render order. The filter row renders entries in this
 * order regardless of which lifecycles the data actually contains;
 * the `available` arg trims unused stages out of the visible UI.
 */
// The four canonical lifecycle stages from @doco/shared, in
// progression order. The filter row renders them in this sequence.
export const LIFECYCLE_ORDER: readonly string[] = ["drafting", "queued", "active", "retired"];

/**
 * Lifecycles hidden out of the box. `retired` is the "no longer
 * current" stage; surfacing it by default would clutter the active
 * picture. Authors can toggle it on to audit historical state.
 */
export const HIDDEN_LIFECYCLES_BY_DEFAULT: ReadonlySet<string> = new Set(["retired"]);

export function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replaceAll("_", " ");
}

/**
 * An edge's effective lifecycle, defaulting to "active" when the edge
 * carries no explicit value (older edges, or links built without a
 * lifecycle column). Mirrors how nodes default in the perspectives.
 */
export function edgeLifecycle(link: { lifecycle?: string | null }): string {
  return link.lifecycle ?? "active";
}

/**
 * Whether an edge survives the lifecycle filter on its OWN lifecycle.
 * The "Life cycle" selections at the bottom of the perspectives apply to
 * edges as well as nodes: a retired edge hides by default (retired is off
 * by default) exactly like a retired node, and toggling "Retired" on
 * reveals both. Endpoint visibility is checked separately by the caller.
 */
export function isEdgeLifecycleVisible(
  link: { lifecycle?: string | null },
  visible: ReadonlySet<string>,
): boolean {
  return visible.has(edgeLifecycle(link));
}

/**
 * Default-visible lifecycle set for an initial useState. Caller
 * passes the lifecycles that exist in their data; this returns the
 * subset that should be on by default.
 */
export function initialVisibleLifecycles(available: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const lifecycle of available) {
    if (!HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle)) out.add(lifecycle);
  }
  return out;
}

/**
 * Reconcile the visible set when the available lifecycles change, surfacing
 * ONLY stages the page hasn't seen before.
 *
 * `known` is the set of every lifecycle already accounted for. Each stage in
 * `available` that isn't in `known` is "new": it's recorded in `nextKnown`,
 * and — unless it hides by default — returned in `newlyVisible` so the caller
 * can switch it on. Stages already known are left untouched, which is the
 * whole point: a default-visible stage the user *unchecked* stays unchecked
 * even though the live feed re-creates the available set every few seconds.
 * Without this, the old "re-seed every default-visible stage" logic flipped
 * the user's choice back on within one revalidation. Pure; never mutates
 * `known`.
 */
export function newlyVisibleLifecycles(
  available: Iterable<string>,
  known: ReadonlySet<string>,
): { newlyVisible: string[]; nextKnown: Set<string> } {
  const nextKnown = new Set(known);
  const newlyVisible: string[] = [];
  for (const lifecycle of available) {
    if (nextKnown.has(lifecycle)) continue;
    nextKnown.add(lifecycle);
    if (!HIDDEN_LIFECYCLES_BY_DEFAULT.has(lifecycle)) newlyVisible.push(lifecycle);
  }
  return { newlyVisible, nextKnown };
}

/**
 * Order `available` lifecycles by LIFECYCLE_ORDER, appending any
 * unknown lifecycle stages at the end alphabetically.
 */
export function orderLifecycles(available: Iterable<string>): string[] {
  const seen = new Set(available);
  const ordered: string[] = [];
  for (const lifecycle of LIFECYCLE_ORDER) {
    if (seen.has(lifecycle)) {
      ordered.push(lifecycle);
      seen.delete(lifecycle);
    }
  }
  // Unknown stages fall in alphabetically.
  for (const remaining of Array.from(seen).sort()) ordered.push(remaining);
  return ordered;
}
