import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, CardTitle } from "~/components/card";
import { cn } from "~/lib/cn";
import { timeAgo } from "~/lib/time-ago";

export interface AccessListItem {
  id: string;
  href: string;
  label: string;
  count: number;
  lastUpdatedAt: string | null;
  children?: AccessListItem[];
}

export function AccessListCard({
  title,
  items,
  empty,
  emptyChildrenLabel = "No docos yet.",
}: {
  title: string;
  items: AccessListItem[];
  empty: ReactNode;
  emptyChildrenLabel?: string;
}) {
  return (
    <Card>
      <div className="px-4 pb-2 pt-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </div>
      <div className="px-4 pb-3 pt-1">
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
            ({item.count})
          </span>
        </div>
        <div className="shrink-0 whitespace-nowrap text-right text-[11px] text-muted-foreground">
          <span>last modified </span>
          <LastModified iso={item.lastUpdatedAt} />
        </div>
      </div>
    </div>
  );
}

function LastModified({ iso }: { iso: string | null }) {
  if (!iso) return <span>never</span>;
  return (
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      {timeAgo(iso)}
    </time>
  );
}
