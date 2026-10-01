import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, CardTitle } from "~/components/card";
import { VisibilityIcon } from "~/components/visibility-icon";
import { cn } from "~/lib/cn";
import { countDocoItems } from "~/lib/doco-templates-meta";
import { timeAgo } from "~/lib/time-ago";

export interface DocoListEntry {
  id: string;
  handle: string;
  href?: string;
  ownerHandle?: string;
  /** The template the Doco was made from, which names what it holds. */
  template: string | null;
  /** How many of the one thing it holds the Doco has. */
  items: number;
  lastUpdatedAt: string | null;
  visibility?: "public" | "private";
}

export function DocoListCard({
  title,
  headerAction,
  docos,
  empty,
  showOwner = true,
}: {
  title?: string;
  headerAction?: ReactNode;
  docos: DocoListEntry[];
  empty: ReactNode;
  showOwner?: boolean;
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
        {docos.length === 0 ? (
          <div className="text-xs text-muted-foreground">{empty}</div>
        ) : (
          <ul className="space-y-1.5">
            {docos.map((d) => (
              <li key={d.id}>
                <DocoLine
                  doco={d}
                  label={showOwner && d.ownerHandle ? `${d.ownerHandle} / ${d.handle}` : d.handle}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function DocoLine({ doco, label }: { doco: DocoListEntry; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden
        className="mt-[0.5rem] size-1.5 shrink-0 rounded-full bg-muted-foreground"
      />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
        <div className="flex min-w-0 items-baseline">
          {doco.visibility ? (
            <VisibilityIcon visibility={doco.visibility} className="mr-1.5 self-center" />
          ) : null}
          <Link
            to={doco.href ?? `/${doco.handle}`}
            className="block min-w-0 truncate text-sm font-semibold text-primary hover:underline"
          >
            {label}
          </Link>
          <span className="ml-1 whitespace-nowrap text-[11px] text-muted-foreground">
            ({countDocoItems(doco.items, doco.template)})
          </span>
        </div>
        <div className="shrink-0 whitespace-nowrap text-right text-[11px] text-muted-foreground">
          <LastUpdatedLabel iso={doco.lastUpdatedAt} />
        </div>
      </div>
    </div>
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
