import { Check, Loader2, X, ZoomIn } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Link } from "react-router";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import type { ApprovalPerspectiveNode } from "~/lib/approval-perspective.server";
import { lifecycleColor } from "~/lib/neuron-colors";
import type { LifecycleStage } from "~/lib/neuron-detail.server";
import { timeAgo } from "~/lib/time-ago";

type ApprovalSortKey =
  | "proposed_desc"
  | "proposed_asc"
  | "created_desc"
  | "created_asc"
  | "author_asc"
  | "type_asc";

const SORT_LABELS: Record<ApprovalSortKey, string> = {
  proposed_desc: "Most recently proposed",
  proposed_asc: "Oldest proposed",
  created_desc: "Newest created",
  created_asc: "Oldest created",
  author_asc: "Author A-Z",
  type_asc: "Type A-Z",
};

const SORT_OPTIONS: ApprovalSortKey[] = [
  "proposed_desc",
  "proposed_asc",
  "created_desc",
  "created_asc",
  "author_asc",
  "type_asc",
];

interface ApprovalPerspectiveProps {
  nodes: readonly ApprovalPerspectiveNode[];
  canChangeLifecycle: boolean;
  onOpenNeuron: (node: ApprovalPerspectiveNode) => void;
  onLifecycleTransition: (
    node: ApprovalPerspectiveNode,
    lifecycle: Extract<LifecycleStage, "active" | "drafting">,
  ) => Promise<void>;
}

export function ApprovalPerspective({
  nodes,
  canChangeLifecycle,
  onOpenNeuron,
  onLifecycleTransition,
}: ApprovalPerspectiveProps) {
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [sort, setSort] = useState<ApprovalSortKey>("proposed_desc");
  const [pending, setPending] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = nodes.filter((node) => !hiddenIds.has(node.id));
    const filtered = needle
      ? base.filter((node) =>
          [node.id, node.entity_type, node.name ?? "", node.author_name ?? "", node.author_id ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : base;
    return sortApprovalNodes(filtered, sort);
  }, [hiddenIds, nodes, query, sort]);

  const changeLifecycle = async (
    node: ApprovalPerspectiveNode,
    lifecycle: Extract<LifecycleStage, "active" | "drafting">,
  ) => {
    const key = `${node.id}:${lifecycle}`;
    setPending(key);
    setError(null);
    try {
      await onLifecycleTransition(node, lifecycle);
      setHiddenIds((prev) => new Set(prev).add(node.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(searchDraft.trim());
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-12">
      <div className="pointer-events-none absolute right-3 top-3 z-20 w-64 max-w-[calc(100%-2rem)]">
        <form
          aria-label="Search approval queue"
          className="pointer-events-auto flex gap-2"
          onSubmit={submitSearch}
        >
          <div className="relative flex-1">
            <input
              type="search"
              value={searchDraft}
              onChange={(event) => {
                const next = event.target.value;
                setSearchDraft(next);
                if (next.trim().length === 0) setQuery("");
              }}
              placeholder="Search approval queue..."
              autoComplete="off"
              spellCheck={false}
              className="neu-inset w-full rounded-md bg-background px-3 py-1.5 text-xs text-foreground outline-none"
            />
          </div>
          <button
            type="submit"
            className="neu-button cursor-pointer rounded-md bg-background px-3 py-1.5 text-xs font-semibold text-foreground"
          >
            Search
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {visible.length} of {nodes.length} proposed neuron{nodes.length === 1 ? "" : "s"}
        </p>
        <label className="inline-flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Sort by</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as ApprovalSortKey)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            {SORT_OPTIONS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {canChangeLifecycle ? null : (
        <p className="text-xs text-muted-foreground">Approver or owner role required to approve.</p>
      )}

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-4 py-3 text-xs italic text-muted-foreground">
            {nodes.length === 0
              ? "No neurons are waiting for approval."
              : "No proposed neurons match this search."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((node) => {
              const approveKey = `${node.id}:active`;
              const rejectKey = `${node.id}:drafting`;
              const disabled = !canChangeLifecycle || !node.update_url || pending !== null;
              return (
                <li
                  key={node.id}
                  className="grid grid-cols-1 gap-2 px-3 py-2 hover:bg-background sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3"
                >
                  <button
                    type="button"
                    onClick={() => onOpenNeuron(node)}
                    className="w-full min-w-0 cursor-pointer text-left"
                    data-neuron-href={node.href}
                    data-neuron-id={node.id}
                    data-neuron-label={node.name ?? node.id}
                    data-neuron-lifecycle={node.lifecycle}
                    data-neuron-type={node.entity_type}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span aria-hidden className="shrink-0">
                        <NeuronTypeIcon entityType={node.entity_type} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {node.name ?? (
                            <span className="italic text-muted-foreground">(unnamed)</span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {node.author_name ?? "Unknown author"} · {ageLabel(node)}
                        </span>
                      </span>
                      <span
                        className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase"
                        style={{
                          color: lifecycleColor(node.lifecycle),
                          borderColor: lifecycleColor(node.lifecycle),
                        }}
                      >
                        {node.lifecycle}
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void changeLifecycle(node, "active")}
                      disabled={disabled}
                      title={
                        canChangeLifecycle ? "Approve neuron" : "Approver or owner role required"
                      }
                      className="neu-button inline-flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11px] font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pending === approveKey ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void changeLifecycle(node, "drafting")}
                      disabled={disabled}
                      title={
                        canChangeLifecycle
                          ? "Reject back to drafting"
                          : "Approver or owner role required"
                      }
                      className="neu-button inline-flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11px] font-semibold text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pending === rejectKey ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      Reject
                    </button>
                    <Link
                      to={node.zoom_href}
                      title="Zoom in on the default perspective"
                      className="neu-button inline-flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11px] font-semibold text-foreground"
                    >
                      <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                      Zoom in
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ageLabel(node: ApprovalPerspectiveNode): string {
  const basis = node.proposed_at ?? node.created_at;
  if (!basis) return "proposal date unknown";
  return `${node.proposed_at ? "Proposed" : "Created"} ${timeAgo(basis)}`;
}

function sortApprovalNodes(
  nodes: readonly ApprovalPerspectiveNode[],
  sort: ApprovalSortKey,
): ApprovalPerspectiveNode[] {
  const arr = [...nodes];
  arr.sort((a, b) => compareApprovalNodes(a, b, sort));
  return arr;
}

function compareApprovalNodes(
  a: ApprovalPerspectiveNode,
  b: ApprovalPerspectiveNode,
  sort: ApprovalSortKey,
): number {
  switch (sort) {
    case "proposed_desc":
      return tsValue(b.proposed_at ?? b.created_at) - tsValue(a.proposed_at ?? a.created_at);
    case "proposed_asc":
      return tsValue(a.proposed_at ?? a.created_at) - tsValue(b.proposed_at ?? b.created_at);
    case "created_desc":
      return tsValue(b.created_at) - tsValue(a.created_at);
    case "created_asc":
      return tsValue(a.created_at) - tsValue(b.created_at);
    case "author_asc":
      return stringValue(a.author_name).localeCompare(stringValue(b.author_name));
    case "type_asc":
      return a.entity_type.localeCompare(b.entity_type);
  }
}

function tsValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: string | null): string {
  return value ?? "";
}
