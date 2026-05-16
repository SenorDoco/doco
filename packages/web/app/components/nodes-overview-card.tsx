import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card } from "~/components/card";

export interface NodesOverviewItem {
  key: string;
  href: string;
  label: ReactNode;
  count: number;
  ariaLabel: string;
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
    <Card>
      <div className="space-y-5 px-5 py-4">
        {search}
        {allEmpty
          ? empty
          : sections.map((section) =>
              section.items.length === 0 ? null : (
                <section key={section.title} className="space-y-2">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.title}
                  </h2>
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                    {section.items.map((item) => (
                      <li key={item.key}>
                        <Link
                          to={item.href}
                          aria-label={item.ariaLabel}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-foreground hover:bg-card"
                          style={
                            item.color
                              ? { boxShadow: `inset 4px 0 0 ${item.color}` }
                              : undefined
                          }
                        >
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          <span className="font-mono tabular-nums text-foreground">
                            {item.count}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
            )}
      </div>
    </Card>
  );
}
