// The top lists beside a workspace's or Doco's activity, over the last 7 days:
// Top contributors and Top queryers (one row per person and the agent they
// worked through, so the same person can appear once per agent and once for
// the website itself) and Top integrations (one row per integration).

import type { ReactNode } from "react";
import { BRAND_ICONS } from "~/components/brand-icons";
import type { ActivitySummary, TopActor, TopIntegration } from "~/lib/activity-log.server";
import { viaLabel } from "~/lib/authoring-provenance";
import { timeAgo } from "~/lib/time-ago";

/** How far back the top lists look. */
export const TOP_DAYS = 7;

const PERIOD = `last ${TOP_DAYS} days`;

export function TopListsSections({ summary }: { summary: ActivitySummary }) {
  return (
    <>
      <TopSection
        title="Top contributors"
        rows={summary.topContributors.map(actorRow)}
        empty={`No writes in the ${PERIOD}.`}
      />
      <TopSection
        title="Top queryers"
        rows={summary.topQueryers.map(actorRow)}
        empty={`No queries in the ${PERIOD}.`}
      />
      <TopSection
        title="Top integrations"
        rows={summary.topIntegrations.map(integrationRow)}
        empty={`No imports in the ${PERIOD}.`}
      />
    </>
  );
}

interface TopRow {
  key: string;
  name: ReactNode;
  title: string;
  count: number;
  lastAt: string;
}

function actorRow(a: TopActor): TopRow {
  const via = viaLabel(a.via);
  return {
    key: `${a.userId}:${a.via ?? ""}`,
    name: (
      <>
        {a.username} <span className="text-muted-foreground">{via}</span>
      </>
    ),
    title: `${a.username} ${via}`,
    count: a.count,
    lastAt: a.lastAt,
  };
}

function integrationRow(i: TopIntegration): TopRow {
  const Icon = BRAND_ICONS[i.integration];
  return {
    key: i.integration,
    name: (
      <>
        {Icon ? <Icon className="mr-1.5 inline-block size-3 align-[-1px]" /> : null}
        {i.name}
      </>
    ),
    title: i.name,
    count: i.count,
    lastAt: i.lastAt,
  };
}

function TopSection({ title, rows, empty }: { title: string; rows: TopRow[]; empty: string }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">· {PERIOD}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"
            >
              <span className="truncate" title={r.title}>
                {r.name}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {r.count.toLocaleString("en-US")}
              </span>
              <time
                dateTime={r.lastAt}
                title={r.lastAt}
                suppressHydrationWarning
                className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
              >
                {timeAgo(r.lastAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
