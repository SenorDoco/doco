import type { ReactNode } from "react";
import { AccessListCard, type AccessListItem } from "~/components/access-list-card";
import type { LifecycleCounts } from "~/lib/node-colors";

export interface DocoListEntry {
  id: string;
  handle: string;
  href?: string;
  ownerHandle?: string;
  nodeCount: number;
  counts?: LifecycleCounts;
  lastUpdatedAt: string | null;
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
  const items: AccessListItem[] = docos.map((d) => ({
    id: d.id,
    href: d.href ?? `/${d.handle}`,
    label: showOwner && d.ownerHandle ? `${d.ownerHandle} / ${d.handle}` : d.handle,
    count: d.nodeCount,
    countLabel: `${d.nodeCount} nodes`,
    counts: d.counts,
    lastUpdatedAt: d.lastUpdatedAt,
  }));

  return <AccessListCard title={title} headerAction={headerAction} items={items} empty={empty} />;
}
