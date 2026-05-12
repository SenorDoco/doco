import { useState } from "react";
import { Link } from "react-router";
import { openDb, getDocoSlug } from "~/lib/db";
import { personalizedPageRank } from "~/lib/pagerank";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { EntityGraph, type GraphLink, type GraphNode } from "~/components/entity-graph";
import { cn } from "~/lib/cn";

const KNOWN = new Set([
  "principal",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "evaluation",
  "reference",
  "scope",
]);

export function loader({ params }: { params: { type: string; id: string } }) {
  const type = params.type;
  const id = params.id;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  const db = openDb();
  try {
    const row = db.prepare(`SELECT raw_json FROM ${type} WHERE id = ?`).get(id) as
      | { raw_json: string }
      | undefined;
    if (!row) throw new Response(`Not found: ${id}`, { status: 404 });
    const ent = JSON.parse(row.raw_json) as Record<string, unknown>;
    const outgoing = db
      .prepare(
        "SELECT to_id, to_node_type, edge_type FROM edges WHERE from_id = ? ORDER BY edge_type, to_id",
      )
      .all(id) as { to_id: string; to_node_type: string; edge_type: string }[];
    const incoming = db
      .prepare(
        "SELECT from_id, from_node_type, edge_type FROM edges WHERE to_id = ? ORDER BY edge_type, from_id",
      )
      .all(id) as { from_id: string; from_node_type: string; edge_type: string }[];

    // ── Personalized PageRank graph view (ADR-076) ────────────────────────
    const allEdges = db
      .prepare(
        "SELECT from_id, to_id, edge_type, from_node_type, to_node_type FROM edges",
      )
      .all() as {
      from_id: string;
      to_id: string;
      edge_type: string;
      from_node_type: string;
      to_node_type: string;
    }[];
    const ppr = personalizedPageRank(
      allEdges.map((e) => ({ from: e.from_id, to: e.to_id, edge_type: e.edge_type })),
      id,
      {
        topK: 25,
        alpha: 0.85,
        // ADR-079: in_scope_of edges weight 2× — scope-shared neighbors rank closer.
        edgeWeight: (t) => (t === "in_scope_of" ? 2 : 1),
      },
    );
    const neighborIds = new Set([id, ...ppr.map((p) => p.id)]);
    // Resolve summaries + types for graph nodes.
    const graphNodes: GraphNode[] = [];
    for (const nid of neighborIds) {
      const m = /^([a-z_]+)_/.exec(nid);
      const nt = m?.[1];
      if (!nt) continue;
      // Try the type's table; fall back to a stub if missing.
      let summary = nid;
      try {
        const r = db.prepare(`SELECT summary FROM ${nt} WHERE id = ?`).get(nid) as
          | { summary: string }
          | undefined;
        if (r?.summary) summary = r.summary;
      } catch {
        /* unknown table; leave summary as id */
      }
      graphNodes.push({ id: nid, node_type: nt, summary, is_center: nid === id });
    }
    const graphLinks: GraphLink[] = allEdges
      .filter((e) => neighborIds.has(e.from_id) && neighborIds.has(e.to_id))
      .map((e) => ({ source: e.from_id, target: e.to_id, edge_type: e.edge_type }));

    // ADR-079: scope landing — when type === "scope", curate members by node_type
    // and surface sub-scopes so the page reads as a topic dashboard.
    let scopeLanding: {
      members: Record<string, { id: string; summary: string; lifecycle: string | null }[]>;
      subScopes: { id: string; name: string }[];
    } | null = null;
    if (type === "scope") {
      const memberTypes = ["intent", "decision", "action", "rule", "idea", "reasoning"] as const;
      const members: Record<
        string,
        { id: string; summary: string; lifecycle: string | null }[]
      > = {};
      for (const t of memberTypes) {
        const rows = db
          .prepare(
            `SELECT t.id, t.summary, t.lifecycle
             FROM ${t} t
             JOIN edges e ON e.from_id = t.id AND e.edge_type = 'in_scope_of' AND e.to_id = ?
             ORDER BY t.id DESC LIMIT 25`,
          )
          .all(id) as { id: string; summary: string; lifecycle: string | null }[];
        if (rows.length > 0) members[t] = rows;
      }
      // Sub-scopes: scopes that have THIS scope in their `scopes` field
      // (parent edge). Per ADR-081 — edge-hierarchical, no slash matching.
      const subScopes = db
        .prepare(
          `SELECT s.id, s.name FROM scope s
           JOIN edges e ON e.from_id = s.id
                       AND e.edge_type = 'in_scope_of'
                       AND e.from_node_type = 'scope'
                       AND e.to_id = ?
           ORDER BY s.name`,
        )
        .all(id) as { id: string; name: string }[];
      scopeLanding = { members, subScopes };
    }

    return {
      ent,
      outgoing,
      incoming,
      type,
      id,
      docoSlug: getDocoSlug(),
      graphNodes,
      graphLinks,
      scopeLanding,
    };
  } finally {
    db.close();
  }
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Entity · Doco" }];
  const display =
    (data.ent.slug as string | undefined) ??
    (data.ent.title as string | undefined) ??
    (data.ent.name as string | undefined) ??
    data.id;
  return [{ title: `${display} · Doco` }];
}

export default function EntityDetail({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ent, type, id, outgoing, incoming, graphNodes, graphLinks, scopeLanding } = loaderData;
  const display =
    (ent.slug as string | undefined) ??
    (ent.title as string | undefined) ??
    (ent.name as string | undefined) ??
    id;

  // Mobile tab state — desktop shows both panes side-by-side.
  const [activeTab, setActiveTab] = useState<"details" | "map">("details");

  const detailsPane = (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardDescription className="font-mono text-[11px]">{id}</CardDescription>
          <CardTitle className="text-lg">{display}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <Badge>{type}</Badge>
            {ent.number ? <Badge variant="accent">{String(ent.number)}</Badge> : null}
            {ent.lifecycle ? <Badge>lifecycle: {String(ent.lifecycle)}</Badge> : null}
            {ent.status ? <Badge>status: {String(ent.status)}</Badge> : null}
            {ent.modality ? <Badge variant="primary">{String(ent.modality)}</Badge> : null}
            {ent.phase ? <Badge variant="primary">{String(ent.phase)}</Badge> : null}
          </div>
          {ent.summary ? <p className="text-xs text-muted-foreground">{String(ent.summary)}</p> : null}
        </CardContent>
      </Card>

      {scopeLanding && (typeof ent.purpose === "string" || typeof ent.guidelines === "string") ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Purpose &amp; guidelines</CardTitle>
            <CardDescription>
              Per ADR-082 — what this scope is for and how to author nodes inside it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {typeof ent.purpose === "string" ? (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Purpose</p>
                <p className="mt-1 text-xs">{String(ent.purpose)}</p>
              </div>
            ) : null}
            {typeof ent.guidelines === "string" ? (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Guidelines</p>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {String(ent.guidelines)}
                </pre>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {scopeLanding ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Members of this scope</CardTitle>
            <CardDescription>
              Per ADR-079 — entities that declare <code>scopes: [{id}]</code> in their
              frontmatter, grouped by node type. Click any to drill in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scopeLanding.subScopes.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  Sub-scopes
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {scopeLanding.subScopes.map((s) => (
                    <Link
                      key={s.id}
                      to={`/e/scope/${s.id}`}
                      className="rounded-full border border-border px-2 py-0.5 text-xs hover:border-primary"
                    >
                      {s.name}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            {Object.entries(scopeLanding.members).map(([t, rows]) => (
              <div key={t}>
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  {t} ({rows.length})
                </p>
                <ul className="mt-1 space-y-1 text-xs">
                  {rows.map((r) => (
                    <li key={r.id} className="flex items-baseline gap-2">
                      <Link
                        to={`/e/${t}/${r.id}`}
                        className="text-primary hover:underline font-mono text-[11px]"
                      >
                        {r.id.slice(0, 36)}
                      </Link>
                      {r.lifecycle ? (
                        <Badge>{r.lifecycle}</Badge>
                      ) : null}
                      <span className="text-muted-foreground truncate">{r.summary}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to={`/e/${t}?scope=${id}`}
                  className="mt-1 inline-block text-[11px] text-primary hover:underline"
                >
                  See all {t}s in this scope →
                </Link>
              </div>
            ))}
            {Object.keys(scopeLanding.members).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No members yet. Reference this scope from any entity's <code>scopes:</code>{" "}
                array to populate the dashboard.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {outgoing.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Edges (outgoing)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>edge type</TableHead>
                  <TableHead>target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outgoing.map((e) => (
                  <TableRow key={`${e.edge_type}-${e.to_id}`}>
                    <TableCell className="font-mono text-xs">{e.edge_type}</TableCell>
                    <TableCell>
                      <Link to={`/e/${e.to_node_type}/${e.to_id}`} className="text-primary hover:underline">
                        {e.to_id}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">({e.to_node_type})</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Referenced by ({incoming.length})
          </CardTitle>
          <CardDescription>
            Other entities that point at this one. Per ADR-075. A zero count is a hint
            that this entity may be isolated — consider whether it should be linked from
            an Action, Decision, or other contextual node.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {incoming.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No incoming references. This entity is currently a leaf in the graph.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>edge type</TableHead>
                  <TableHead>source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incoming.map((e) => (
                  <TableRow key={`${e.edge_type}-${e.from_id}`}>
                    <TableCell className="font-mono text-xs">{e.edge_type}</TableCell>
                    <TableCell>
                      <Link to={`/e/${e.from_node_type}/${e.from_id}`} className="text-primary hover:underline">
                        {e.from_id}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">({e.from_node_type})</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Raw entity</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border border-border bg-input p-3 text-[12px] leading-snug">
            {JSON.stringify(ent, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );

  const mapPane = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Map ({graphNodes.length} nodes)</CardTitle>
        <CardDescription>
          Personalized PageRank from this node, treating edges as undirected. Per ADR-076.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EntityGraph centerId={id} nodes={graphNodes} links={graphLinks} />
      </CardContent>
    </Card>
  );

  return (
    <div>
      <SiteHeader context={loaderData.docoSlug} />
      <main className="mx-auto max-w-7xl px-6 py-6">
        {/* Mobile tabs (hidden md+) */}
        <div className="md:hidden mb-4 flex gap-2 border-b border-border">
          <button
            type="button"
            onClick={() => setActiveTab("details")}
            className={cn(
              "px-3 py-2 text-xs",
              activeTab === "details"
                ? "border-b-2 border-primary font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("map")}
            className={cn(
              "px-3 py-2 text-xs",
              activeTab === "map"
                ? "border-b-2 border-primary font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Map
          </button>
        </div>

        {/* Layout: 2 columns desktop, single column mobile (controlled by tab) */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          <div className={cn(activeTab === "details" ? "block" : "hidden", "md:block")}>
            {detailsPane}
          </div>
          <div className={cn(activeTab === "map" ? "block" : "hidden", "md:block")}>
            {mapPane}
          </div>
        </div>
      </main>
    </div>
  );
}
