import { useEffect, useState } from "react";
import { cn } from "~/lib/cn";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function timeAgo(releasedAt: number, now: number): string {
  const diff = Math.max(0, now - releasedAt);
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m}m ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}h ago`;
  }
  const d = Math.floor(diff / DAY);
  return `${d}d ago`;
}

interface VersionPillProps {
  className?: string;
}

export const DOCO_TAGLINE = "Doco: keep people, agents, and work aligned.";

/**
 * Identity strip beside the DocoMark on every page: "Alpha <version> · <ago>"
 * with the project tagline underneath.
 * Replaces the prior owner/doco slug breadcrumb (which only appeared on
 * Doco-scoped pages and re-stated info already in the URL). Build-time
 * constants come from vite.config.ts; the relative-time string refreshes
 * client-side so a long-lived session doesn't show stale "2m ago".
 */
export function VersionPill({ className }: VersionPillProps) {
  const releasedAt = new Date(__DOCO_RELEASE_AT__).getTime();
  const [ago, setAgo] = useState(() => timeAgo(releasedAt, releasedAt));
  useEffect(() => {
    const tick = () => setAgo(timeAgo(releasedAt, Date.now()));
    tick();
    const id = window.setInterval(tick, MINUTE);
    return () => window.clearInterval(id);
  }, [releasedAt]);
  return (
    <span
      className={cn(
        "flex flex-col gap-0.5 font-normal text-xs leading-tight text-muted-foreground",
        className,
      )}
      suppressHydrationWarning
    >
      <span>
        Alpha {__DOCO_VERSION__} · {ago}
      </span>
      <span>{DOCO_TAGLINE}</span>
    </span>
  );
}
