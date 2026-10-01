// The cards of a Doco's activity column: the Activity chart, who wrote to and
// queried it most, and the latest recorded writes. Every Doco home shows them,
// and the reader (codebase, Notion) shows them beside whatever is open.

import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { TopActorsList } from "~/components/top-actors-list";
import type { DocoActivity, DocoFeedItem } from "~/lib/doco-activity.server";
import type { TopActor } from "~/lib/top-actors.server";

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

/** Top contributors and Top queryers, one row per person and agent. */
export function TopActorsSections({
  contributors,
  queryers,
}: {
  contributors: TopActor[];
  queryers: TopActor[];
}) {
  return (
    <>
      <section className="space-y-1">
        <h2 className="text-xs font-semibold text-foreground">Top contributors</h2>
        <TopActorsList actors={contributors} empty="No recorded contributions yet." />
      </section>
      <section className="space-y-1">
        <h2 className="text-xs font-semibold text-foreground">Top queryers</h2>
        <TopActorsList actors={queryers} empty="No recorded queries yet." />
      </section>
    </>
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
          <TopActorsSections
            contributors={activity.topContributors}
            queryers={activity.topQueryers}
          />
        </CardContent>
      </Card>
      <LatestActivityCard items={activity.items} handle={handle} />
    </div>
  );
}
