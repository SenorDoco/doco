import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, CardTitle } from "~/components/card";
import { LifecycleCountsLabel } from "~/components/lifecycle-counts";
import { VisibilityIcon } from "~/components/visibility-icon";
import { cn } from "~/lib/cn";
import type { Copied } from "~/lib/doco-stats.server";
import type { LifecycleCounts } from "~/lib/node-colors";
import { timeAgo } from "~/lib/time-ago";

export interface AccessListItem {
  id: string;
  href: string;
  label: string;
  count: number;
  countLabel?: string;
  counts?: LifecycleCounts;
  /** What a Doco copied from its source, shown next to its node counts. */
  copied?: Copied | null;
  lastUpdatedAt: string | null;
  /** Doco (leaf) rows carry their visibility so the list can mark it;
   *  workspace (group) rows leave it unset. */
  visibility?: "public" | "private";
  children?: AccessListItem[];
}

export function AccessListCard({
  title,
  headerAction,
  items,
  empty,
  emptyChildrenLabel = "No docos yet.",
}: {
  title?: string;
  headerAction?: ReactNode;
  items: AccessListItem[];
  empty: ReactNode;
  emptyChildrenLabel?: string;
}) {
  const hasHeader = Boolean(title || headerAction);
  return (
    <Card>
      {hasHeader ? (
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
          {title ? <CardTitle className="text-sm">{title}</CardTitle> : <span />}
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
      ) : null}
      <div className={cn("px-4 pb-3", hasHeader ? "pt-1" : "pt-3")}>
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground">{empty}</div>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <AccessListEntry
                key={item.id}
                item={item}
                depth={0}
                emptyChildrenLabel={emptyChildrenLabel}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function AccessListEntry({
  item,
  depth,
  emptyChildrenLabel,
}: {
  item: AccessListItem;
  depth: number;
  emptyChildrenLabel: string;
}) {
  return (
    <li>
      <AccessLine item={item} compact={depth > 0} />
      {item.children ? (
        item.children.length === 0 ? (
          <p className="ml-4 mt-1 text-xs text-muted-foreground">{emptyChildrenLabel}</p>
        ) : (
          <ul className="ml-5 mt-1 space-y-1">
            {item.children.map((child) => (
              <AccessListEntry
                key={child.id}
                item={child}
                depth={depth + 1}
                emptyChildrenLabel={emptyChildrenLabel}
              />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

function AccessLine({ item, compact = false }: { item: AccessListItem; compact?: boolean }) {
  // Group rows (workspaces) summarize their children, so they don't carry their
  // own last-updated stamp — only leaf rows (docos) do.
  const isGroup = Array.isArray(item.children);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden
        className={cn(
          "shrink-0 rounded-full bg-muted-foreground",
          compact ? "mt-[0.42rem] size-1" : "mt-[0.5rem] size-1.5",
        )}
      />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
        <div className="flex min-w-0 items-baseline">
          {item.visibility ? (
            <VisibilityIcon visibility={item.visibility} className="mr-1.5 self-center" />
          ) : null}
          <Link
            to={item.href}
            className={cn(
              "block min-w-0 truncate font-semibold text-primary hover:underline",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {item.label}
          </Link>
          <span className="ml-1 whitespace-nowrap text-[11px] text-muted-foreground">
            {item.counts ? (
              <>
                {"("}
                <CountsLabel counts={item.counts} count={item.count} copied={item.copied ?? null} />
                {")"}
              </>
            ) : (
              `(${item.countLabel ?? item.count})`
            )}
          </span>
        </div>
        {isGroup ? null : (
          <div className="shrink-0 whitespace-nowrap text-right text-[11px] text-muted-foreground">
            <LastUpdatedLabel iso={item.lastUpdatedAt} />
          </div>
        )}
      </div>
    </div>
  );
}

// A Doco that copies a source holds copies, not nodes: they stand in for
// empty counts.
function CountsLabel({
  counts,
  count,
  copied,
}: {
  counts: LifecycleCounts;
  count: number;
  copied: Copied | null;
}) {
  const showCounts = !copied || count > 0;
  return (
    <>
      {showCounts ? <LifecycleCountsLabel counts={counts} /> : null}
      {copied
        ? `${showCounts ? " · " : ""}${copied.count.toLocaleString("en-US")} ${copied.unit}${
            copied.count === 1 ? "" : "s"
          }`
        : null}
    </>
  );
}

function LastUpdatedLabel({ iso }: { iso: string | null }) {
  if (!iso) return <span>no activity yet</span>;
  return (
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      last updated {timeAgo(iso)}
    </time>
  );
}
