// Side drawer that overlays the entity graph on the node detail view.
// Renders one detail "page" at a time — Info, Edges, History, or Metadata —
// based on the `open` kind. Closing returns control to the graph.
//
// Driven by the parent route's state; no internal route, no portals. The
// drawer is positioned absolute over the graph column so the chat pane
// on the left stays interactive while the drawer is open.

import { Link } from "react-router";
import { NodeTypeBadge } from "~/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

export type DrawerKind = "info" | "edges" | "history" | "metadata";

export interface DrawerEdge {
  edge_type: string;
  /** The id of the OTHER node — to_id for outgoing, from_id for incoming. */
  other_id: string;
  other_node_type: string;
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
  node_type: string;
  summary: string;
  name: string | null;
  ppr: number;
  gpr: number;
}

export interface NodeDetailDrawerProps {
  open: DrawerKind | null;
  onClose: () => void;
  /** Builds the URL for a related entity (kind + id). */
  linkTo: (kind: string, otherId: string) => string;
  // Info pane
  nodeId: string;
  nodeCreatedAt: string | null;
  nodeGpr: number | null;
  rankedNeighbors: DrawerRelevantNode[];
  // Edges pane
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
    case "info":
      return "Info";
    case "edges":
      return "Edges";
    case "history":
      return "History";
    case "metadata":
      return "Metadata";
  }
}

export function NodeDetailDrawer(props: NodeDetailDrawerProps) {
  const { open, onClose } = props;
  if (!open) return null;
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-border bg-card shadow-lg"
      aria-label={`${paneTitle(open)} pane`}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
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
        {open === "info" ? <InfoPane {...props} /> : null}
        {open === "edges" ? <EdgesPane {...props} /> : null}
        {open === "history" ? <HistoryPane {...props} /> : null}
        {open === "metadata" ? <MetadataPane {...props} /> : null}
      </div>
    </aside>
  );
}

function InfoPane({
  nodeId,
  nodeCreatedAt,
  nodeGpr,
  rankedNeighbors,
  linkTo,
}: NodeDetailDrawerProps) {
  return (
    <div className="space-y-4 text-xs">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2">
        <dt className="text-muted-foreground">Id</dt>
        <dd className="font-mono break-all">{nodeId}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd className="font-mono">
          {nodeCreatedAt ? `${nodeCreatedAt} · ${relativeTimeIso(nodeCreatedAt)}` : "—"}
        </dd>
        <dt className="text-muted-foreground">Global PageRank</dt>
        <dd className="font-mono">{nodeGpr !== null ? nodeGpr.toFixed(4) : "—"}</dd>
      </dl>
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Most relevant nodes ({rankedNeighbors.length})
        </h3>
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {rankedNeighbors.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">No neighbors yet.</li>
          ) : (
            rankedNeighbors.map((n) => (
              <li key={n.id}>
                <Link to={linkTo(n.node_type, n.id)} className="block px-3 py-2 hover:bg-input/40">
                  <div className="flex items-center gap-2">
                    <NodeTypeBadge nodeType={n.node_type} className="text-[10px] uppercase" />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      PPR {n.ppr.toFixed(3)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-foreground">{n.summary?.slice(0, 120) ?? n.id}</p>
                </Link>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function EdgesPane({ outgoing, incoming, linkTo }: NodeDetailDrawerProps) {
  return (
    <div className="space-y-4 text-xs">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Outgoing ({outgoing.length})
        </h3>
        {outgoing.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No outgoing edges.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>edge</TableHead>
                <TableHead>target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outgoing.map((e) => (
                <TableRow key={`out-${e.edge_type}-${e.other_id}`}>
                  <TableCell className="font-mono text-[11px]">{e.edge_type}</TableCell>
                  <TableCell>
                    <Link
                      to={linkTo(e.other_node_type, e.other_id)}
                      className="text-primary hover:underline"
                    >
                      {e.other_id}
                    </Link>
                    <span className="ml-2 text-muted-foreground">({e.other_node_type})</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Referenced by ({incoming.length})
        </h3>
        {incoming.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No incoming references.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>edge</TableHead>
                <TableHead>source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incoming.map((e) => (
                <TableRow key={`in-${e.edge_type}-${e.other_id}`}>
                  <TableCell className="font-mono text-[11px]">{e.edge_type}</TableCell>
                  <TableCell>
                    <Link
                      to={linkTo(e.other_node_type, e.other_id)}
                      className="text-primary hover:underline"
                    >
                      {e.other_id}
                    </Link>
                    <span className="ml-2 text-muted-foreground">({e.other_node_type})</span>
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

function HistoryPane({ history }: NodeDetailDrawerProps) {
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
            <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-input p-2 text-[11px] leading-snug">
              {JSON.stringify({ before: e.before, after: e.after }, null, 2)}
            </pre>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function MetadataPane({ ent }: NodeDetailDrawerProps) {
  return (
    <dl className="divide-y divide-border text-xs">
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
      <details className="mt-3 pt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          Raw JSON
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-input p-3 text-[11px] leading-snug">
          {JSON.stringify(ent, null, 2)}
        </pre>
      </details>
    </dl>
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
