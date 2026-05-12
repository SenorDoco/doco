import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Badge } from "~/components/badge";
import type { RecentItem } from "~/routes/_index";

const POLL_INTERVAL_MS = 5_000;

/**
 * Live Recent feed (ADR-089).
 *
 * Renders an initial list (oldest at top, newest at bottom) and polls
 * `/api/recent?since=<latest-created_at>` every 5 seconds, appending any new
 * items at the bottom. When the user is scrolled up away from the latest item
 * and new items land off-screen, a sticky "N new ↓" badge surfaces them.
 *
 * Server-side rendering provides the initial list; this component layers
 * polling + scroll-aware affordances on top. No SSE/WebSockets — polling is
 * cheap and the per-Doco cadence is forgiving.
 */
export function RecentFeed({ initialItems }: { initialItems: RecentItem[] }) {
  const [items, setItems] = useState<RecentItem[]>(initialItems);
  const [unseenCount, setUnseenCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isAtBottom = useIsAtBottom(bottomRef);

  // Poll for new items.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const latest = items.at(-1)?.created_at;
      if (!latest) return;
      try {
        const res = await fetch(`/api/recent?since=${encodeURIComponent(latest)}`);
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { items: RecentItem[] };
        if (cancelled || body.items.length === 0) return;
        setItems((prev) => {
          const known = new Set(prev.map((i) => i.id));
          const additions = body.items.filter((i) => !known.has(i.id));
          return additions.length === 0 ? prev : [...prev, ...additions];
        });
        if (!isAtBottom) setUnseenCount((n) => n + body.items.length);
      } catch {
        // network blip — try again on the next tick
      }
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [items, isAtBottom]);

  // Reset the unseen counter once the user scrolls to the bottom.
  useEffect(() => {
    if (isAtBottom) setUnseenCount(0);
  }, [isAtBottom]);

  return (
    <div className="relative">
      <div className="divide-y divide-border">
        {items.map((it) => (
          <Row key={it.id} it={it} />
        ))}
        <div ref={bottomRef} />
      </div>

      {unseenCount > 0 ? (
        <button
          type="button"
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
          className="sticky bottom-4 ml-auto block w-fit rounded-full border border-primary bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md hover:opacity-90"
        >
          {unseenCount} new ↓
        </button>
      ) : null}
    </div>
  );
}

function Row({ it }: { it: RecentItem }) {
  return (
    <div className="px-5 py-3.5">
      <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
        <Badge variant={it.node_type === "decision" ? "accent" : "default"}>{it.node_type}</Badge>
        {it.number ? <Badge variant="accent">{it.number}</Badge> : null}
        <Link
          to={`/e/${it.node_type}/${it.id}`}
          className="text-sm font-semibold text-foreground hover:text-primary"
        >
          {it.title ?? it.slug ?? it.id}
        </Link>
      </div>
      <div className="text-xs text-muted-foreground">
        {it.summary} <span className="ml-1 font-mono">· {it.created_at}</span>
      </div>
    </div>
  );
}

/**
 * `true` when `el` is at or near the bottom of its scrollable viewport.
 * Uses IntersectionObserver so detection is GPU-cheap.
 */
function useIsAtBottom(elRef: React.RefObject<HTMLDivElement | null>): boolean {
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setAtBottom(entry.isIntersecting);
      },
      { rootMargin: "0px 0px 100px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [elRef]);
  return atBottom;
}
