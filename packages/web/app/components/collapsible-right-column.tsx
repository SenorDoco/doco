// CollapsibleRightColumn — a generic right-side rail that can be
// collapsed to a thin vertical tab showing a label.
//
// Pure UI. State is per-device (localStorage). Use for page-local
// "stats & activity" type rails that the user might want to hide on a
// narrower laptop.

import { useCallback, useEffect, useState } from "react";
import { CollapsedRail } from "~/components/agent-sidebar";

interface Props {
  /** Vertical-tab label when collapsed. */
  label: string;
  /** localStorage key — keep stable across renders. Example: "stats-activity:doco-home". */
  storageKey: string;
  /** Content rendered when expanded. */
  children: React.ReactNode;
  /** Tailwind classes for the expanded shell — controls width / sticky positioning. */
  expandedClassName?: string;
}

function readFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function CollapsibleRightColumn({
  label,
  storageKey,
  children,
  expandedClassName = "",
}: Props) {
  // Always start expanded so SSR matches the first client render. The
  // useEffect below promotes to the stored collapsed state right after
  // hydration — a brief flash is the trade we make to keep markup
  // identical on the server and client.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (readFlag(storageKey)) setCollapsed(true);
  }, [storageKey]);

  const persist = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      try {
        if (next) window.localStorage.setItem(storageKey, "1");
        else window.localStorage.removeItem(storageKey);
      } catch {
        // localStorage blocked — UI state updates anyway.
      }
    },
    [storageKey],
  );

  if (collapsed) {
    return <CollapsedRail label={label} side="right" onExpand={() => persist(false)} />;
  }
  return (
    <section className={expandedClassName}>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => persist(true)}
          className="inline-flex items-center gap-1 rounded p-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-input hover:text-foreground"
          aria-label={`Collapse ${label}`}
          title="Collapse"
        >
          Hide
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="6 4 11 8 6 12" />
          </svg>
        </button>
      </div>
      {children}
    </section>
  );
}
