import { ArrowRight, Loader2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { LinkedProse, LinkedValue } from "~/components/linked-text";
import { LifecycleBadge, TypeBadge } from "~/components/node-badges";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { lifecycleColor } from "~/lib/node-colors";
import type { LifecycleStage, NodeDialogDetail } from "~/lib/node-detail.server";

/** What an edge row needs to open the edge's own dialog. */
export interface OpenEdgeTarget {
  id: string;
  href: string;
  source: string;
  target: string;
}

/**
 * A node-dialog edge row is "retired" when either the edge itself or the
 * node on the other end is retired. Such rows hide by default — the dialog
 * surfaces a "Show retired edges and nodes" toggle when any exist, so the
 * active picture stays uncluttered while history is still reachable.
 */
export function isRetiredEdgeRow(edge: {
  edge_lifecycle: string;
  other_lifecycle: string;
}): boolean {
  return edge.edge_lifecycle === "retired" || edge.other_lifecycle === "retired";
}

interface NodeDialogProps {
  detail: NodeDialogDetail | null;
  loading: boolean;
  error: string | null;
  lifecycleUpdating: LifecycleStage | null;
  lifecycleError: string | null;
  onClose: () => void;
  onLifecycleChange: (stage: LifecycleStage) => void;
  onOpenNode: (nodeType: string, id: string, href: string) => void;
  onOpenEdge: (edge: OpenEdgeTarget) => void;
}

function displayDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AuthoringValue({
  entry,
}: {
  entry: NonNullable<NodeDialogDetail["authoring"]["created"]>;
}) {
  const actor = entry.user_label ?? entry.user_id;
  const actorTitle =
    actor && entry.user_id && actor !== entry.user_id ? `${actor} (${entry.user_id})` : actor;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {actor ? (
        <span
          className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1 break-words"
          title={actorTitle ?? undefined}
        >
          {actor}
        </span>
      ) : (
        <span className="text-muted-foreground">Unknown user</span>
      )}
      {entry.mechanism ? (
        <span className="text-muted-foreground">via {entry.mechanism}</span>
      ) : null}
    </span>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function lifecycleButtonClass(detail: NodeDialogDetail, stage: LifecycleStage, active: boolean) {
  const base =
    "inline-flex h-8 min-w-0 items-center justify-center rounded-md border border-border px-3 text-[11px] font-semibold capitalize";
  if (active) {
    return `${base} neu-pressed`;
  }
  const option = detail.lifecycle_options.find((candidate) => candidate.value === stage);
  if (option?.disabled) {
    return `${base} neu-button cursor-not-allowed opacity-55`;
  }
  return `${base} neu-button`;
}

function DocoSourceLine({ doco }: { doco: NodeDialogDetail["doco"] | null | undefined }) {
  if (!doco) return null;
  return (
    <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
      Doco{" "}
      <Link
        to={doco.href}
        className="font-mono font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline"
      >
        {doco.handle}
      </Link>
    </p>
  );
}

export function NodeDialog({
  detail,
  loading,
  error,
  lifecycleUpdating,
  lifecycleError,
  onClose,
  onLifecycleChange,
  onOpenNode,
  onOpenEdge,
}: NodeDialogProps) {
  const title = detail?.primary_text ?? detail?.name ?? detail?.summary ?? detail?.id ?? "Node";
  const disabledReason = detail?.lifecycle_options.find(
    (option) => option.disabled && !option.current,
  )?.reason;
  const hasPrimaryText = Boolean(detail?.primary_text);
  // Retired edges and retired nodes hide by default; the toggle reveals
  // them only when the viewer asks. Counted across both directions so a
  // single button governs the whole Edges section.
  const [showRetired, setShowRetired] = useState(false);
  const incoming = detail?.incoming ?? [];
  const outgoing = detail?.outgoing ?? [];
  const retiredEdgeCount =
    incoming.filter(isRetiredEdgeRow).length + outgoing.filter(isRetiredEdgeRow).length;
  const visibleIncoming = showRetired ? incoming : incoming.filter((e) => !isRetiredEdgeRow(e));
  const visibleOutgoing = showRetired ? outgoing : outgoing.filter((e) => !isRetiredEdgeRow(e));

  return (
    <aside
      className="neu-floating relative z-30 flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-white"
      aria-label="Node details"
    >
      <header className="px-4 py-3">
        <div className="flex items-start gap-3">
          {detail ? (
            <NodeTypeIcon nodeType={detail.node_type} className="mt-0.5 !h-4 !w-4 shrink-0" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                  {detail?.node_type ?? "Node"}
                </p>
                {hasPrimaryText ? null : (
                  <h2 className="mt-0.5 break-words text-sm font-semibold leading-snug text-foreground">
                    {title}
                  </h2>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="neu-button inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Close node details"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        {detail ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap gap-1.5" aria-label="Lifecycle stages">
              {detail.lifecycle_options.map((option) => {
                const color = lifecycleColor(option.value);
                const busy = lifecycleUpdating === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={option.disabled || busy || lifecycleUpdating !== null}
                    onClick={() => onLifecycleChange(option.value)}
                    title={option.reason ?? `Mark as ${option.value}`}
                    className={lifecycleButtonClass(detail, option.value, option.current)}
                    style={{ color }}
                  >
                    {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                    {option.label}
                  </button>
                );
              })}
            </div>
            {disabledReason ? (
              <p className="text-[11px] leading-snug text-muted-foreground">{disabledReason}</p>
            ) : null}
            {lifecycleError ? (
              <p className="text-[11px] leading-snug text-destructive">{lifecycleError}</p>
            ) : null}
          </div>
        ) : null}
      </header>

      <div
        className="node-dialog-scroll min-h-0 flex-1 overflow-y-scroll px-4 pb-8 pt-4"
        style={{ scrollbarGutter: "stable" }}
      >
        {loading ? (
          <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading node...
          </div>
        ) : null}
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {detail && !loading ? (
          <div className="space-y-5 text-xs">
            {detail.primary_text ? (
              <section>
                <div className="whitespace-pre-wrap break-words text-sm font-bold leading-6 text-foreground">
                  <LinkedProse text={detail.primary_text} />
                </div>
                <DocoSourceLine doco={detail.doco} />
              </section>
            ) : null}

            <section>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">Id</dt>
                <dd className="break-all font-mono">{detail.id}</dd>
                {detail.locator ? (
                  <>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="min-w-0 break-all">
                      <LinkedValue value={detail.locator} githubRepo={detail.github_repo} />
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Lifecycle</dt>
                <dd className="font-mono" style={{ color: lifecycleColor(detail.lifecycle) }}>
                  {detail.lifecycle}
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{displayDate(detail.created_at)}</dd>
                {detail.authoring.created ? (
                  <>
                    <dt className="text-muted-foreground">Created by</dt>
                    <dd>
                      <AuthoringValue entry={detail.authoring.created} />
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{displayDate(detail.updated_at)}</dd>
                {detail.authoring.updated ? (
                  <>
                    <dt className="text-muted-foreground">Updated by</dt>
                    <dd>
                      <AuthoringValue entry={detail.authoring.updated} />
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Role</dt>
                <dd>{detail.user_role ?? "none"}</dd>
              </dl>
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Edges
              </h3>
              <div className="space-y-4">
                <EdgeList
                  label="Incoming"
                  direction="incoming"
                  currentNodeId={detail.id}
                  edges={visibleIncoming}
                  onOpenNode={onOpenNode}
                  onOpenEdge={onOpenEdge}
                />
                <EdgeList
                  label="Outgoing"
                  direction="outgoing"
                  currentNodeId={detail.id}
                  edges={visibleOutgoing}
                  onOpenNode={onOpenNode}
                  onOpenEdge={onOpenEdge}
                />
              </div>
              {retiredEdgeCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowRetired((prev) => !prev)}
                  className="neu-button mt-3 inline-flex items-center rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  aria-pressed={showRetired}
                >
                  {showRetired
                    ? "Hide retired edges and nodes"
                    : `Show retired edges and nodes (${retiredEdgeCount})`}
                </button>
              ) : null}
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Lifecycle History
              </h3>
              {detail.lifecycle_history.length === 0 ? (
                <p className="text-muted-foreground">No lifecycle transitions recorded.</p>
              ) : (
                <ol className="space-y-2">
                  {detail.lifecycle_history.map((entry, index) => (
                    <li
                      key={`${entry.at}-${index}`}
                      className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {displayDate(entry.at)}
                      </span>
                      <span className="font-mono">
                        {entry.from ?? "(initial)"} {"->"} {entry.to}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                History
              </h3>
              {detail.history.length === 0 ? (
                <p className="text-muted-foreground">No audit events yet.</p>
              ) : (
                <ol className="space-y-3">
                  {detail.history.map((event) => (
                    <li key={event.event_id} className="border-l-2 border-border pl-3">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {displayDate(event.at)} · {event.by ?? "anonymous"} ·{" "}
                        <span className="text-foreground">{event.op}</span>
                      </div>
                      {event.before || event.after ? (
                        <pre className="neu-surface mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card p-2 text-[11px] leading-snug">
                          {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Metadata
              </h3>
              <dl className="divide-y divide-border">
                {Object.entries(detail.frontmatter).map(([key, value]) => (
                  <div key={key} className="grid gap-2 py-2 md:grid-cols-[8rem_minmax(0,1fr)]">
                    <dt className="font-mono text-muted-foreground">{key}</dt>
                    <dd className="min-w-0">
                      <code className="block whitespace-pre-wrap break-words font-mono text-[11px]">
                        {typeof value === "string" ? (
                          <LinkedValue value={value} githubRepo={detail.github_repo} />
                        ) : (
                          formatValue(value)
                        )}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
              <details className="pt-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                  Raw JSON
                </summary>
                <pre className="neu-surface mt-2 overflow-auto rounded-md bg-card p-3 text-[11px] leading-snug">
                  {detail.raw_json}
                </pre>
              </details>
            </section>
          </div>
        ) : null}
      </div>
      {/* Bottom fade — tells the user content extends below the visible
          area even when the OS auto-hides the scrollbar. pointer-events
          off so it doesn't swallow clicks on the last row of content. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-lg bg-gradient-to-t from-card to-transparent"
      />
    </aside>
  );
}

export function EdgeList({
  label,
  direction,
  currentNodeId,
  edges,
  onOpenNode,
  onOpenEdge,
}: {
  label: string;
  // "incoming": other → this node. "outgoing": this node → other.
  direction: "incoming" | "outgoing";
  currentNodeId: string;
  edges: NodeDialogDetail["outgoing"];
  onOpenNode: (nodeType: string, id: string, href: string) => void;
  onOpenEdge: (edge: OpenEdgeTarget) => void;
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {label} ({edges.length})
      </h4>
      {edges.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <ul className="neu-surface divide-y divide-border">
          {edges.map((edge) => {
            const edgeTitle = edge.other_name ?? edge.other_summary ?? edge.other_id;
            const retired = edge.other_lifecycle === "retired";
            // A retired edge strikes through its own type (and label) so the
            // relationship reads as "no longer current" — mirroring how a
            // retired node on the other end strikes through its title below.
            const edgeRetired = edge.edge_lifecycle === "retired";
            // Endpoints from this node's vantage: an outgoing edge runs from
            // this node to the other; an incoming edge runs from the other to
            // this node. The edge dialog re-centers the canvas on `source`.
            const source = direction === "outgoing" ? currentNodeId : edge.other_id;
            const target = direction === "outgoing" ? edge.other_id : currentNodeId;
            const edgeColor = lifecycleColor(edge.edge_lifecycle);
            return (
              <li
                key={`${label}-${edge.edge_id}`}
                className="space-y-1.5 px-3 py-2 hover:bg-input/20"
              >
                {/* The edge itself — a first-class entity. Clicking opens the
                    edge dialog (its lifecycle, history, both endpoints). */}
                <button
                  type="button"
                  onClick={() =>
                    onOpenEdge({ id: edge.edge_id, href: edge.edge_href, source, target })
                  }
                  title={`Open edge: ${edge.edge_type}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-input/40"
                >
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span
                    className={`truncate font-mono${
                      edgeRetired ? " line-through decoration-2" : ""
                    }`}
                    style={{ color: edgeColor }}
                  >
                    {edge.edge_type}
                  </span>
                  {edge.edge_label ? (
                    <span
                      className={`truncate font-mono text-muted-foreground${
                        edgeRetired ? " line-through decoration-2" : ""
                      }`}
                    >
                      {edge.edge_label}
                    </span>
                  ) : null}
                </button>
                {/* The node on the other end. Clicking opens its node dialog. */}
                <button
                  type="button"
                  className="block w-full rounded-md text-left hover:bg-input/30"
                  onClick={() =>
                    onOpenNode(
                      edge.other_node_type,
                      edge.other_id,
                      edge.href ?? `/${edge.other_node_type}/${edge.other_id}`,
                    )
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1" aria-label="Related node">
                      <TypeBadge
                        nodeType={edge.other_node_type}
                        lifecycle={edge.other_lifecycle}
                        anchor="inline"
                      />
                      <LifecycleBadge lifecycle={edge.other_lifecycle} anchor="inline" />
                    </span>
                  </div>
                  <p
                    className={`mt-1 break-words text-xs text-foreground ${
                      retired ? "text-muted-foreground line-through decoration-2" : ""
                    }`}
                  >
                    {edgeTitle}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
