// The cards of a Doco's activity column: the Activity calendars, the last 7
// days' top contributors, queryers and integrations, and the latest recorded
// writes. Every Doco home shows them, and the reader (codebase, Notion) shows
// them beside whatever is open.

import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { TopListsSections } from "~/components/top-list";
import type { DailyActivity } from "~/lib/activity-log.server";
import type { DocoActivity, DocoFeedItem } from "~/lib/doco-activity.server";

/** Writes, queries and imports each day. */
export function ActivityCard({ byDay }: { byDay: DailyActivity }) {
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
        <CardContent className="space-y-4 p-5">
          <TopListsSections summary={activity.lastWeek} />
        </CardContent>
      </Card>
      <LatestActivityCard items={activity.items} handle={handle} />
    </div>
  );
}
