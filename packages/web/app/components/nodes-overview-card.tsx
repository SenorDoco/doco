import type { ReactNode } from "react";
import { Link } from "react-router";

export interface NodesOverviewItem {
  key: string;
  href: string;
  label: string;
  count: number;
  ariaLabel: string;
  icon?: string;
  color?: string;
}

export interface NodesOverviewSection {
  title: string;
  items: NodesOverviewItem[];
}

export function NodesOverviewCard({
  search,
  sections,
  empty,
}: {
  search?: ReactNode;
  sections: NodesOverviewSection[];
  empty?: ReactNode;
}) {
  const allEmpty = sections.every((s) => s.items.length === 0);
  return (
    <div className="space-y-4">
      {search}
      {allEmpty
        ? empty
        : sections.map((section) =>
            section.items.length === 0 ? null : (
              <section key={section.title} className="space-y-1">
                <h2 className="text-xs text-muted-foreground">{section.title}</h2>
                {section.items.map((item) => (
                  <div
                    key={item.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
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
                      <span
                        className="truncate"
                        style={item.color ? { color: item.color } : undefined}
                      >
                        {item.label}
                      </span>
                    </Link>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      {item.count}
                    </span>
                  </div>
                ))}
              </section>
            ),
          )}
    </div>
  );
}
