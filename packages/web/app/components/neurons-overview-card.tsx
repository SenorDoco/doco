import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card } from "~/components/card";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/neuron-colors";
import { timeAgo } from "~/lib/time-ago";

export interface NodesOverviewItem {
  key: string;
  href: string;
  label: string;
  count: number;
  activeCount?: number;
  ariaLabel: string;
  icon?: ReactNode;
  color?: string;
  updatedAt?: string | null;
}

export interface NeuronsOverviewSection {
  title: string;
  items: NodesOverviewItem[];
}

export function NeuronsOverviewCard({
  search,
  sections,
  empty,
  aside,
}: {
  search?: ReactNode;
  sections: NeuronsOverviewSection[];
  empty?: ReactNode;
  aside?: ReactNode;
}) {
  const allEmpty = sections.every((s) => s.items.length === 0);
  const sectionsBlock = allEmpty
    ? empty
    : sections.map((section) =>
        section.items.length === 0 ? null : (
          <section key={section.title} className="space-y-1">
            <h2 className="text-xs font-semibold text-foreground">{section.title}</h2>
            {section.items.map((item) => (
              <div
                key={item.key}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3"
              >
                <Link
                  to={item.href}
                  aria-label={item.ariaLabel}
                  className="flex min-w-0 items-center gap-2 text-xs hover:text-primary"
                >
                  {item.icon ? (
                    <span aria-hidden className="shrink-0 text-[12px] leading-none">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="truncate" style={item.color ? { color: item.color } : undefined}>
                    {item.label}
                  </span>
                </Link>
                <span
                  className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                  title={typeof item.activeCount === "number" ? "active / total" : undefined}
                >
                  {typeof item.activeCount === "number" ? (
                    <>
                      <span style={{ color: lifecycleColor("accepted") }}>{item.activeCount}</span>
                      {`/${item.count}`}
                    </>
                  ) : (
                    item.count
                  )}
                </span>
                <time
                  dateTime={item.updatedAt ?? undefined}
                  title={item.updatedAt ?? undefined}
                  suppressHydrationWarning
                  className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
                >
                  {timeAgo(item.updatedAt)}
                </time>
              </div>
            ))}
          </section>
        ),
      );
  return (
    <Card>
      {search ? <div className="p-5">{search}</div> : null}
      {aside ? (
        <div className={cn("space-y-4", search ? "border-t border-border" : null)}>
          <div className="min-w-0 space-y-4 p-5">{sectionsBlock}</div>
          <div className="min-w-0 space-y-4 border-t border-border p-5">{aside}</div>
        </div>
      ) : (
        <div className={cn("space-y-4 p-5", search ? "border-t border-border" : null)}>
          {sectionsBlock}
        </div>
      )}
    </Card>
  );
}
