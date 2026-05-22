// List perspective — vertical, sortable list of neurons.
//
// Primary sort options (dropdown, top-right):
//   recent      — created_at desc (default)
//   oldest      — created_at asc
//   rank_desc   — global PageRank, highest first
//   rank_asc    — global PageRank, lowest first
//
// Type-aware secondary sort: when two neurons tie on the primary key,
// they're broken first by neuron-type rank (intents → decisions →
// actions → … → constitution primitives stay pinned near the top
// because they're meta), then by a type-specific tiebreaker:
//   decision/intent/rule/action → lifecycle rank (active first)
//   log/eval                     → created_at desc (recent matters more)
//   guidance/auth primitives     → name asc (stable alphabetical)
// Primitives are pinned ABOVE the body for `rank_desc` since they're
// the Doco's authoring contract.

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { lifecycleColor } from "~/lib/neuron-colors";
import { timeAgo } from "~/lib/time-ago";

export type ListSortKey = "recent" | "oldest" | "rank_desc" | "rank_asc";

const SORT_LABELS: Record<ListSortKey, string> = {
  recent: "Most recent first",
  oldest: "Oldest first",
  rank_desc: "Global page rank — highest first",
  rank_asc: "Global page rank — lowest first",
};

const SORT_OPTIONS: ListSortKey[] = ["recent", "oldest", "rank_desc", "rank_asc"];

const NEURON_TYPE_ORDER = new Map(
  [
    "guidance_primitive",
    "neuron_authoring_primitive",
    "intent",
    "decision",
    "action",
    "rule",
    "state",
    "log",
    "eval",
    "reference",
    "idea",
  ].map((type, index) => [type, index]),
);

// Canonical Lifecycle (@doco/shared) — seven stages, ranked here
// for tiebreaker sort within a neuron type. Lower index = preferred.
const LIFECYCLE_RANK = new Map(
  [
    "active",
    "drafted",
    "proposed",
    "succeeded",
    "superseded",
    "abandoned",
    "failed",
  ].map((lifecycle, index) => [lifecycle, index]),
);

const CONSTITUTION_TYPES = new Set(["guidance_primitive", "neuron_authoring_primitive"]);

export interface ListPerspectiveNode {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href?: string | null;
}

interface ListPerspectiveProps {
  nodes: readonly ListPerspectiveNode[];
  pageRanks: Map<string, number>;
  /**
   * Page-level lifecycle filter set. Nodes whose lifecycle isn't in
   * this set are excluded before sort. When omitted, every node
   * is shown.
   */
  visibleLifecycles?: Set<string>;
}

export function ListPerspective({ nodes, pageRanks, visibleLifecycles }: ListPerspectiveProps) {
  const [sort, setSort] = useState<ListSortKey>("recent");

  const filtered = useMemo(() => {
    if (!visibleLifecycles) return nodes;
    return nodes.filter((node) => visibleLifecycles.has(node.lifecycle ?? "active"));
  }, [nodes, visibleLifecycles]);

  const sorted = useMemo(
    () => sortNodes(filtered, sort, pageRanks),
    [filtered, sort, pageRanks],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {filtered.length} neuron{filtered.length === 1 ? "" : "s"}
        </p>
        <label className="inline-flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Sort by</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as ListSortKey)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            {SORT_OPTIONS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-input">
        {sorted.length === 0 ? (
          <p className="px-4 py-3 text-xs italic text-muted-foreground">
            This Doco has no neurons yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map((node) => (
              <ListRow key={node.id} node={node} sort={sort} rank={pageRanks.get(node.id)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface ListRowProps {
  node: ListPerspectiveNode;
  sort: ListSortKey;
  rank: number | undefined;
}

function ListRow({ node, sort, rank }: ListRowProps) {
  const inner = (
    <div className="flex items-center gap-3 px-3 py-2 text-xs">
      <span aria-hidden className="shrink-0">
        <NeuronTypeIcon entityType={node.entity_type} />
      </span>
      <span className="min-w-0 flex-1 truncate" title={node.name ?? undefined}>
        {node.name ?? <span className="italic text-muted-foreground">(unnamed)</span>}
      </span>
      {node.lifecycle ? (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
          style={{ color: lifecycleColor(node.lifecycle), borderColor: lifecycleColor(node.lifecycle) }}
        >
          {node.lifecycle}
        </span>
      ) : null}
      <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
        {sort === "rank_desc" || sort === "rank_asc"
          ? rank !== undefined
            ? rank.toExponential(2)
            : "—"
          : node.created_at
            ? timeAgo(node.created_at)
            : "—"}
      </span>
    </div>
  );
  return (
    <li>
      {node.href ? (
        <Link to={node.href} className="block hover:bg-background">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}

function sortNodes(
  nodes: readonly ListPerspectiveNode[],
  sort: ListSortKey,
  pageRanks: Map<string, number>,
): ListPerspectiveNode[] {
  const arr = [...nodes];
  arr.sort((a, b) => compareForSort(a, b, sort, pageRanks));
  return arr;
}

function compareForSort(
  a: ListPerspectiveNode,
  b: ListPerspectiveNode,
  sort: ListSortKey,
  pageRanks: Map<string, number>,
): number {
  const primary = primaryCompare(a, b, sort, pageRanks);
  if (primary !== 0) return primary;
  return typeAwareCompare(a, b, sort);
}

function primaryCompare(
  a: ListPerspectiveNode,
  b: ListPerspectiveNode,
  sort: ListSortKey,
  pageRanks: Map<string, number>,
): number {
  switch (sort) {
    case "recent":
      return tsValue(b.created_at) - tsValue(a.created_at);
    case "oldest":
      return tsValue(a.created_at) - tsValue(b.created_at);
    case "rank_desc": {
      // Constitution primitives pin above the body: they're not graph
      // citizens in the same sense, so ranking them by PR is misleading.
      const pinDiff = constitutionPin(a) - constitutionPin(b);
      if (pinDiff !== 0) return pinDiff;
      return (pageRanks.get(b.id) ?? 0) - (pageRanks.get(a.id) ?? 0);
    }
    case "rank_asc":
      return (pageRanks.get(a.id) ?? 0) - (pageRanks.get(b.id) ?? 0);
  }
}

function typeAwareCompare(
  a: ListPerspectiveNode,
  b: ListPerspectiveNode,
  sort: ListSortKey,
): number {
  // First: neuron-type canonical order.
  const typeDiff = neuronTypeRank(a.entity_type) - neuronTypeRank(b.entity_type);
  if (typeDiff !== 0) return typeDiff;

  // Within type: type-specific tiebreaker.
  switch (a.entity_type) {
    case "decision":
    case "intent":
    case "rule":
    case "action":
    case "state":
    case "idea":
      return lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle);
    case "log":
    case "eval":
      return tsValue(b.created_at) - tsValue(a.created_at);
    case "guidance_primitive":
    case "neuron_authoring_primitive":
    case "reference":
      return (a.name ?? "").localeCompare(b.name ?? "");
  }
  // Fallback: alphabetical by name.
  if (sort === "oldest" || sort === "rank_asc") {
    return tsValue(a.created_at) - tsValue(b.created_at);
  }
  return tsValue(b.created_at) - tsValue(a.created_at);
}

function neuronTypeRank(type: string): number {
  return NEURON_TYPE_ORDER.get(type) ?? NEURON_TYPE_ORDER.size + 1;
}

function lifecycleRank(lifecycle: string | null): number {
  return LIFECYCLE_RANK.get(lifecycle ?? "active") ?? LIFECYCLE_RANK.size + 1;
}

function constitutionPin(node: ListPerspectiveNode): number {
  return CONSTITUTION_TYPES.has(node.entity_type) ? 0 : 1;
}

function tsValue(value: string | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}
