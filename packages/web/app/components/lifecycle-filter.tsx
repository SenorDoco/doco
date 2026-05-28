// Lifecycle filter row — checkboxes that toggle which lifecycle
// stages are visible in the active perspective. The filter is a
// page-level concern: it applies across every perspective (graph,
// list, BPMN) so switching tabs preserves the user's hide/show
// choices.
//
// The component is "controlled" — state lives in the caller. Use
// `initialVisibleLifecycles(...)` to seed the state with the project
// default (everything except retired, which hides out of the box).

import { lifecycleColor } from "~/lib/neuron-colors";

/**
 * Canonical render order. The filter row renders entries in this
 * order regardless of which lifecycles the data actually contains;
 * the `available` arg trims unused stages out of the visible UI.
 */
// The four canonical lifecycle stages from @doco/shared, in
// progression order. The filter row renders them in this sequence.
export const LIFECYCLE_ORDER: readonly string[] = ["drafting", "proposed", "accepted", "retired"];

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

interface LifecycleFilterProps {
  /**
   * Lifecycles to render in the row. Typically the union of every
   * lifecycle present in the active perspective's data plus the
   * canonical LIFECYCLE_ORDER so the row stays stable when data
   * comes and goes.
   */
  available: Iterable<string>;
  /** Currently-visible set. */
  visible: Set<string>;
  /** Called when a stage is toggled. */
  onToggle: (lifecycle: string) => void;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

export function LifecycleFilter({ available, visible, onToggle, className }: LifecycleFilterProps) {
  const ordered = orderLifecycles(available);
  if (ordered.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 text-xs ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Life cycle:</span>
        {ordered.map((lifecycle) => {
          const checked = visible.has(lifecycle);
          const color = lifecycleColor(lifecycle);
          const label = lifecycleLabel(lifecycle);
          return (
            <label
              key={lifecycle}
              className="inline-flex cursor-pointer select-none items-center gap-1"
              title={label}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(lifecycle)}
                className="h-3 w-3"
                style={{ accentColor: color }}
              />
              <span className="capitalize" style={{ color }}>
                {label}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
