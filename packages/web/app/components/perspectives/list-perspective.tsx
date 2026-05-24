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
// actions → … → policies stay pinned near the top
// because they're meta), then by a type-specific tiebreaker:
//   decision/intent/rule/action → lifecycle rank (active first)
//   log/eval                     → created_at desc (recent matters more)
//   guidance/auth policies     → name asc (stable alphabetical)
// Policies are pinned ABOVE the body for `rank_desc` since they're
// the Doco's authoring contract.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import {
  type GraphReferenceItem,
  clearGraphReferences,
  publishGraphReferences,
} from "~/lib/graph-references";
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
    "guidance_policy",
    "neuron_authoring_policy",
    "principal",
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

// Canonical Lifecycle (@doco/shared) — four stages, ranked here
// for tiebreaker sort within a neuron type. Lower index = preferred
// (active first since it's the most current state).
// Canonical lifecycle progression (drafting → proposed → active → retired).
// Used here as a tiebreaker sort within a neuron type so lists agree with
// the lifecycle filter row and the doco-stats card on render order.
const LIFECYCLE_RANK = new Map(
  ["drafting", "proposed", "active", "retired"].map((lifecycle, index) => [lifecycle, index]),
);

const POLICY_TYPES = new Set(["guidance_policy", "neuron_authoring_policy"]);
const MAX_GRAPH_REFERENCES = 120;

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
  const graphReferenceIdRef = useRef(`list-${Math.random().toString(36).slice(2)}`);
  const [sort, setSort] = useState<ListSortKey>("recent");

  const filtered = useMemo(() => {
    if (!visibleLifecycles) return nodes;
    return nodes.filter((node) => visibleLifecycles.has(node.lifecycle ?? "active"));
  }, [nodes, visibleLifecycles]);

  const sorted = useMemo(() => sortNodes(filtered, sort, pageRanks), [filtered, sort, pageRanks]);

  const graphReferences = useMemo<GraphReferenceItem[]>(
    () =>
      sorted.slice(0, MAX_GRAPH_REFERENCES).map((node, index) => ({
        number: index + 1,
        id: node.id,
        entity_type: node.entity_type,
        label: node.name ?? node.id,
        lifecycle: node.lifecycle ?? "active",
        href: node.href ?? null,
      })),
    [sorted],
  );

  const referenceNumberByNodeId = useMemo(
    () => new Map(graphReferences.map((reference) => [reference.id, reference.number])),
    [graphReferences],
  );

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    publishGraphReferences(graphId, "list", graphReferences);
  }, [graphReferences]);

  useEffect(() => {
    const graphId = graphReferenceIdRef.current;
    return () => clearGraphReferences(graphId);
  }, []);

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
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md rounded-tl-none border border-border bg-input">
        {sorted.length === 0 ? (
          <p className="px-4 py-3 text-xs italic text-muted-foreground">
            This Doco has no neurons yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map((node) => (
              <ListRow
                key={node.id}
                node={node}
                sort={sort}
                rank={pageRanks.get(node.id)}
                referenceNumber={referenceNumberByNodeId.get(node.id)}
              />
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
  referenceNumber?: number;
}

function ListRow({ node, sort, rank, referenceNumber }: ListRowProps) {
  const inner = (
    <div
      className="flex items-center gap-3 px-3 py-2 text-xs"
      data-graph-reference-number={referenceNumber ?? undefined}
      data-neuron-href={node.href ?? undefined}
      data-neuron-id={node.id}
      data-neuron-label={node.name ?? node.id}
      data-neuron-lifecycle={node.lifecycle ?? "active"}
      data-neuron-type={node.entity_type}
    >
      {referenceNumber ? (
        <span
          aria-label={`Graph reference #${referenceNumber}: ${node.name ?? node.id}`}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm ring-2 ring-card"
          title={`Graph reference #${referenceNumber}`}
        >
          #{referenceNumber}
        </span>
      ) : null}
      <span aria-hidden className="shrink-0">
        <NeuronTypeIcon entityType={node.entity_type} />
      </span>
      <span className="min-w-0 flex-1 truncate" title={node.name ?? undefined}>
        {node.name ?? <span className="italic text-muted-foreground">(unnamed)</span>}
      </span>
      {node.lifecycle ? (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
          style={{
            color: lifecycleColor(node.lifecycle),
            borderColor: lifecycleColor(node.lifecycle),
          }}
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
      // Policies pin above the body: they're not graph
      // citizens in the same sense, so ranking them by PR is misleading.
      const pinDiff = policyPin(a) - policyPin(b);
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
    case "guidance_policy":
    case "neuron_authoring_policy":
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

function policyPin(node: ListPerspectiveNode): number {
  return POLICY_TYPES.has(node.entity_type) ? 0 : 1;
}

function tsValue(value: string | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}
