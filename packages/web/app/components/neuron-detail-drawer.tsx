// Side drawer that overlays the entity graph on the neuron detail view.
// Renders one detail "page" at a time — Relevant neurons, Synapses, History,
// or Metadata — based on the `open` kind. Closing returns control to
// the graph.
//
// Metadata also carries the focal neuron's id / created / Global PageRank
// stats (folded in after the standalone Info pane was retired — they
// were redundant with the YAML frontmatter dump).
//
// Driven by the parent route's state; no internal route, no portals.

import { Link } from "react-router";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

export type DrawerKind = "relevant" | "synapses" | "history" | "metadata";

export interface DrawerEdge {
  synapse_type: string;
  /** The id of the OTHER neuron — to_id for outgoing, from_id for incoming. */
  other_id: string;
  other_neuron_type: string;
}

export interface DrawerHistoryEvent {
  event_id: string;
  at: string;
  by: string | null;
  op: string;
  before?: unknown;
  after?: unknown;
}

export interface DrawerRelevantNode {
  id: string;
  entity_type: string;
  /**
   * Human-readable one-line label. For migrated neurons this is the
   * first line of the type-named column (intent/decision/...); for
   * non-migrated neurons (principals) this is the legacy summary. The
   * route building the list is responsible for picking the right
   * source — the drawer just renders it.
   */
  label: string;
  name: string | null;
  ppr: number;
  gpr: number;
}

export interface DrawerLifecycleChange {
  at: string;
  from: string | null;
  to: string;
}

export interface NeuronDetailDrawerProps {
  open: DrawerKind | null;
  onClose: () => void;
  /** Builds the URL for a related entity (kind + id). */
  linkTo: (kind: string, otherId: string) => string;
  // Relevant-nodes + Metadata panes (focal node stats live in Metadata).
  nodeId: string;
  nodeCreatedAt: string | null;
  nodeGpr: number | null;
  rankedNeighbors: DrawerRelevantNode[];
  /** Lifecycle transitions in newest-first order. Surfaced in the Metadata pane. */
  lifecycleHistory: DrawerLifecycleChange[];
  // Synapses pane
  outgoing: DrawerEdge[];
  incoming: DrawerEdge[];
  // History pane
  history: DrawerHistoryEvent[];
  // Metadata pane
  ent: Record<string, unknown>;
}

function relativeTimeIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const deltaMs = Date.now() - t;
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function paneTitle(kind: DrawerKind): string {
  switch (kind) {
    case "relevant":
      return "Relevant neurons";
    case "synapses":
      return "Synapses";
    case "history":
      return "History";
    case "metadata":
      return "Metadata";
  }
}

export function NeuronDetailDrawer(props: NeuronDetailDrawerProps) {
  const { open, onClose } = props;
  if (!open) return null;
  return (
    <aside
      className="neu-floating absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col bg-card"
      aria-label={`${paneTitle(open)} pane`}
    >
      <header className="flex items-center justify-between px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-tight">{paneTitle(open)}</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close pane"
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {open === "relevant" ? <RelevantNeuronsPane {...props} /> : null}
        {open === "synapses" ? <SynapsesPane {...props} /> : null}
        {open === "history" ? <HistoryPane {...props} /> : null}
        {open === "metadata" ? <MetadataPane {...props} /> : null}
      </div>
    </aside>
  );
}

function RelevantNeuronsPane({ rankedNeighbors, linkTo }: NeuronDetailDrawerProps) {
  if (rankedNeighbors.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No neighbors yet. This neuron sits as a leaf in the graph.
      </p>
    );
  }
  return (
    <div className="text-xs">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Ranked by personalized PageRank from this neuron (ADR-076).
      </p>
      <ul className="neu-surface divide-y divide-border rounded-md">
        {rankedNeighbors.map((n) => (
          <li key={n.id}>
            <Link to={linkTo(n.entity_type, n.id)} className="block px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
                <NeuronTypeIcon entityType={n.entity_type} />
                <span>{n.entity_type}</span>
                <span className="ml-2 font-mono normal-case">PPR {n.ppr.toFixed(3)}</span>
              </div>
              <p className="mt-0.5 text-foreground">{n.label?.slice(0, 120) ?? n.id}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SynapsesPane({ outgoing, incoming, linkTo }: NeuronDetailDrawerProps) {
  return (
    <div className="space-y-4 text-xs">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Incoming ({incoming.length})
        </h3>
        {incoming.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No incoming synapses.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>synapse</TableHead>
                <TableHead>source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incoming.map((e) => (
                <TableRow key={`in-${e.synapse_type}-${e.other_id}`}>
                  <TableCell className="font-mono text-[11px]">{e.synapse_type}</TableCell>
                  <TableCell>
                    <Link
                      to={linkTo(e.other_neuron_type, e.other_id)}
                      className="text-primary hover:underline"
                    >
                      {e.other_id}
                    </Link>
                    <span className="ml-2 text-muted-foreground">({e.other_neuron_type})</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Outgoing ({outgoing.length})
        </h3>
        {outgoing.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No outgoing synapses.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>synapse</TableHead>
                <TableHead>target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outgoing.map((e) => (
                <TableRow key={`out-${e.synapse_type}-${e.other_id}`}>
                  <TableCell className="font-mono text-[11px]">{e.synapse_type}</TableCell>
                  <TableCell>
                    <Link
                      to={linkTo(e.other_neuron_type, e.other_id)}
                      className="text-primary hover:underline"
                    >
                      {e.other_id}
                    </Link>
                    <span className="ml-2 text-muted-foreground">({e.other_neuron_type})</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function HistoryPane({ history }: NeuronDetailDrawerProps) {
  if (!history || history.length === 0) {
    return <p className="text-xs text-muted-foreground">No audit events yet for this node.</p>;
  }
  return (
    <ol className="space-y-2 text-xs">
      {history.map((e) => (
        <li key={e.event_id} className="border-l-2 border-border pl-3">
          <div className="text-muted-foreground">
            <code className="font-mono">{e.at.replace("T", " ").slice(0, 19)}Z</code>
            <span className="mx-2">·</span>
            <code className="font-mono">{e.by ?? "anonymous"}</code>
            <span className="mx-2">·</span>
            <span className="font-medium text-foreground">{e.op}</span>
          </div>
          {e.before || e.after ? (
            <pre className="neu-surface mt-1 whitespace-pre-wrap break-words rounded-md bg-card p-2 text-[11px] leading-snug">
              {JSON.stringify({ before: e.before, after: e.after }, null, 2)}
            </pre>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function MetadataPane({
  nodeId,
  nodeCreatedAt,
  nodeGpr,
  lifecycleHistory,
  ent,
}: NeuronDetailDrawerProps) {
  return (
    <div className="space-y-3 text-xs">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 pb-3">
        <dt className="text-muted-foreground">Id</dt>
        <dd className="break-all font-mono">{nodeId}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd className="font-mono">
          {nodeCreatedAt ? `${nodeCreatedAt} · ${relativeTimeIso(nodeCreatedAt)}` : "—"}
        </dd>
        <dt className="text-muted-foreground">Global PageRank</dt>
        <dd className="font-mono">{nodeGpr !== null ? nodeGpr.toFixed(4) : "—"}</dd>
      </dl>
      <section className="pb-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Lifecycle history ({lifecycleHistory.length})
        </h3>
        {lifecycleHistory.length === 0 ? (
          <p className="mt-1 text-muted-foreground">
            No lifecycle transitions recorded. The neuron remains at its initial stage since
            creation.
          </p>
        ) : (
          <ol className="mt-2 space-y-1">
            {lifecycleHistory.map((entry, i) => (
              <li
                key={`${entry.at}-${i}`}
                className="grid grid-cols-[max-content_1fr] gap-x-3 font-mono"
              >
                <span className="text-muted-foreground">
                  {entry.at.replace("T", " ").slice(0, 19)}Z
                </span>
                <span>
                  {entry.from ?? "(initial)"} → <span className="font-semibold">{entry.to}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <dl className="divide-y divide-border">
        {Object.entries(ent).map(([key, value]) => (
          <div key={key} className="grid gap-2 py-2 md:grid-cols-[10rem_1fr]">
            <dt className="font-mono text-muted-foreground">{key}</dt>
            <dd className="min-w-0">
              <code className="block whitespace-pre-wrap break-words font-mono text-[11px]">
                {formatMetadataValue(value)}
              </code>
            </dd>
          </div>
        ))}
      </dl>
      <details className="pt-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          Raw JSON
        </summary>
        <pre className="neu-surface mt-2 overflow-x-auto rounded-md bg-card p-3 text-[11px] leading-snug">
          {JSON.stringify(ent, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function formatMetadataValue(value: unknown): string {
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
