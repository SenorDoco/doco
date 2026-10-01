import type { ReactNode } from "react";
import { AccessListCard, type AccessListItem } from "~/components/access-list-card";
import type { Copied } from "~/lib/doco-stats.server";
import type { LifecycleCounts } from "~/lib/node-colors";

export interface DocoListEntry {
  id: string;
  handle: string;
  href?: string;
  ownerHandle?: string;
  nodeCount: number;
  counts?: LifecycleCounts;
  /** What the Doco copied from its source; copies are not nodes. */
  copied?: Copied | null;
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
  const items: AccessListItem[] = docos.map((d) => ({
    id: d.id,
    href: d.href ?? `/${d.handle}`,
    label: showOwner && d.ownerHandle ? `${d.ownerHandle} / ${d.handle}` : d.handle,
    count: d.nodeCount,
    countLabel: `${d.nodeCount} nodes`,
    counts: d.counts,
    copied: d.copied,
    lastUpdatedAt: d.lastUpdatedAt,
    visibility: d.visibility,
  }));

  return <AccessListCard title={title} headerAction={headerAction} items={items} empty={empty} />;
}
