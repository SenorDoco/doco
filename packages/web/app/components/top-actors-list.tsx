// The Top contributors and Top queryers lists: one row per person and the
// agent they worked through, so the same person can appear once per agent and
// once for the website itself.

import type { TopActor } from "~/lib/activity-log.server";
import { timeAgo } from "~/lib/time-ago";

export function TopActorsList({ actors, empty }: { actors: TopActor[]; empty: string }) {
  if (actors.length === 0) {
    return <p className="text-xs italic text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-1">
      {actors.map((a) => {
        const via = a.via ? `via ${a.via}` : "on the website";
        return (
          <li
            key={`${a.userId}:${a.via ?? ""}`}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"
          >
            <span className="truncate" title={`${a.username} ${via}`}>
              {a.username} <span className="text-muted-foreground">{via}</span>
            </span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {a.count.toLocaleString("en-US")}
            </span>
            <time
              dateTime={a.lastAt}
              title={a.lastAt}
              suppressHydrationWarning
              className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
            >
              {timeAgo(a.lastAt)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
