import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

export interface NodesOverviewTile {
  key: string;
  href: string;
  badge: ReactNode;
  count: number;
  ariaLabel: string;
  color?: string;
}

export function NodesOverviewCard({
  total,
  viewHref,
  tiles,
  search,
  empty,
}: {
  total: number;
  viewHref: string;
  tiles: NodesOverviewTile[];
  search?: ReactNode;
  empty?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>Nodes ({total})</CardTitle>
        <Link
          to={viewHref}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-card"
        >
          View them
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {tiles.length === 0 ? (
          empty
        ) : (
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            {tiles.map((tile) => (
              <Link
                key={tile.key}
                to={tile.href}
                className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2 text-foreground hover:bg-card"
                style={
                  tile.color
                    ? {
                        background: `color-mix(in oklch, ${tile.color} 8%, white)`,
                        boxShadow: `inset 4px 0 0 ${tile.color}`,
                      }
                    : undefined
                }
                aria-label={tile.ariaLabel}
              >
                <span className="min-w-0 truncate">{tile.badge}</span>
                <span className="font-mono tabular-nums">{tile.count}</span>
              </Link>
            ))}
          </div>
        )}
        {search}
      </CardContent>
    </Card>
  );
}
