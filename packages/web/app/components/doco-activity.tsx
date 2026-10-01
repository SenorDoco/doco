// The cards of a Doco's activity column: the Activity chart, who contributed
// most, and the latest recorded writes. Every Doco home shows them, and the
// reader (codebase, Notion) shows them beside whatever is open.

import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import type { DocoActivity, DocoFeedItem, TopContributor } from "~/lib/doco-activity.server";
import { timeAgo } from "~/lib/time-ago";

/** How much happened each day of the last year. */
export function ActivityCard({ byDay }: { byDay: Record<string, number> }) {
  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <ActivityHeatmap byDay={byDay} />
      </CardContent>
    </Card>
  );
}

export function TopContributorsList({ contributors }: { contributors: TopContributor[] }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs font-semibold text-foreground">Top contributors</h2>
      {contributors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No recorded contributions yet.</p>
      ) : (
        contributors.map((c) => (
          <div key={c.userId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <span className="truncate text-xs" title={c.username}>
              {c.username}
            </span>
            <time
              dateTime={c.lastAt}
              title={c.lastAt}
              suppressHydrationWarning
              className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
            >
              {timeAgo(c.lastAt)}
            </time>
          </div>
        ))
      )}
    </section>
  );
}

/** The latest recorded writes, each linking to its node. */
export function LatestActivityCard({
  items,
  handle,
  onOpenNode,
}: {
  items: DocoFeedItem[];
  handle: string;
  /** Opens the node in place instead of following its link. */
  onOpenNode?: (item: ActivityFeedLineItem, href: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">Latest activity</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
            No recorded activity yet. Capture a node from the API or CLI; this feed records UI, CLI,
            and API writes.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((it) => (
              <ActivityFeedLine
                key={it.event_id}
                item={it}
                docoHandle={handle}
                onOpenNode={onOpenNode}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The whole column, as the reader shows it. */
export function ActivityColumn({ activity, handle }: { activity: DocoActivity; handle: string }) {
  return (
    <div className="min-w-0 space-y-5">
      <ActivityCard byDay={activity.byDay} />
      <Card>
        <CardContent className="p-5">
          <TopContributorsList contributors={activity.topContributors} />
        </CardContent>
      </Card>
      <LatestActivityCard items={activity.items} handle={handle} />
    </div>
  );
}
