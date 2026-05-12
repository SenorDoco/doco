import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import type { EntityId } from "@doco/shared";
import { docoPath, openDocoDb } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { personalizedPageRank } from "@doco/index";
import {
  deleteScopeInDoco,
  reindex,
  updateScopeInDoco,
} from "~/lib/redeem.server";
import { listScopeFiles } from "~/lib/scope-helpers.server";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { EntityGraph, type GraphLink, type GraphNode } from "~/components/entity-graph";
import { cn } from "~/lib/cn";

const KNOWN = new Set([
  "principal",
  "organization",
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

export function loader({
  params,
}: {
  params: { ownerSlug: string; docoSlug: string; type: string; id: string };
}) {
  const { ownerSlug, docoSlug, type, id } = params;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  const db = openDocoDb(ownerSlug, docoSlug);
  try {
    const row = db.prepare(`SELECT raw_json FROM ${type} WHERE id = ?`).get(id) as
      | { raw_json: string }
      | undefined;
    if (!row) throw new Response(`Not found: ${id}`, { status: 404 });
    const ent = JSON.parse(row.raw_json) as Record<string, unknown>;
    const outgoing = db
      .prepare("SELECT to_id, to_node_type, edge_type FROM edges WHERE from_id = ? ORDER BY edge_type, to_id")
      .all(id) as { to_id: string; to_node_type: string; edge_type: string }[];
    const incoming = db
      .prepare("SELECT from_id, from_node_type, edge_type FROM edges WHERE to_id = ? ORDER BY edge_type, from_id")
      .all(id) as { from_id: string; from_node_type: string; edge_type: string }[];

    // Personalized PageRank graph view (ADR-076).
    const allEdges = db
      .prepare("SELECT from_id, to_id, edge_type FROM edges")
      .all() as { from_id: string; to_id: string; edge_type: string }[];
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
    const graphNodes: GraphNode[] = [];
    for (const nid of neighborIds) {
      const m = /^([a-z_]+)_/.exec(nid);
      const nt = m?.[1];
      if (!nt) continue;
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

    // Scope landing — when type === "scope", curate members + sub-scopes
    // (ADR-079, ADR-081, ADR-082).
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
      // Sub-scopes from parent edges (ADR-081), not slash matching.
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

    // ADR-084 follow-up: scope detail page edits purpose/guidelines + reparent
    // + delete. The reparent picker needs the full list of other scopes; the
    // delete-confirm needs counts of (members, sub-scopes) so we can refuse if
    // the scope has refbacks.
    let allScopes: { id: string; name: string }[] = [];
    let memberCount = 0;
    if (type === "scope") {
      allScopes = db
        .prepare("SELECT id, name FROM scope WHERE id != ? ORDER BY name")
        .all(id) as { id: string; name: string }[];
      const m = db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE to_id = ? AND edge_type = 'in_scope_of' AND from_node_type != 'scope'`,
        )
        .get(id) as { n: number };
      memberCount = m.n;
    }

    return {
      ent,
      outgoing,
      incoming,
      type,
      id,
      ownerSlug,
      docoSlug,
      host: loadHostConfig(),
      graphNodes,
      graphLinks,
      scopeLanding,
      allScopes,
      memberCount,
    };
  } finally {
    db.close();
  }
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string; type: string; id: string };
}) {
  const { ownerSlug, docoSlug, type, id } = params;
  if (type !== "scope") {
    return { error: "Inline edit is only supported for scopes today." };
  }
  const dir = docoPath(ownerSlug, docoSlug);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scopeId = id as EntityId<"scope">;

  if (intent === "save_scope") {
    const purpose = String(form.get("purpose") ?? "").trim();
    const guidelines = String(form.get("guidelines") ?? "").trim();
    try {
      await updateScopeInDoco({
        docoDir: dir,
        scopeId,
        purpose: purpose || null,
        guidelines: guidelines || null,
      });
      await reindex(dir);
    } catch (e) {
      return { error: `Failed to save: ${(e as Error).message}` };
    }
    return redirect(`/${ownerSlug}/${docoSlug}/e/scope/${id}`);
  }

  if (intent === "reparent") {
    const parentIds = form
      .getAll("parent_id")
      .map((v) => String(v))
      .filter((v) => v.length > 0) as EntityId<"scope">[];
    try {
      await updateScopeInDoco({
        docoDir: dir,
        scopeId,
        parentScopes: parentIds,
      });
      await reindex(dir);
    } catch (e) {
      return { error: `Failed to reparent: ${(e as Error).message}` };
    }
    return redirect(`/${ownerSlug}/${docoSlug}/e/scope/${id}`);
  }

  if (intent === "delete") {
    // Re-check refbacks at action time (loader counts are stale by now).
    const all = listScopeFiles(dir);
    const me = all.find((s) => s.id === id);
    const subCount = me ? 0 : 0; // computed below from db
    // Cheap check via the scopes folder: anyone whose `scopes:` includes me?
    // Done via the indexed db rather than re-parsing every yaml.
    const db = openDocoDb(ownerSlug, docoSlug);
    try {
      const memberRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE to_id = ? AND edge_type = 'in_scope_of'`,
        )
        .get(id) as { n: number };
      if (memberRow.n > 0) {
        return {
          error: `Can't delete: ${memberRow.n} entity/entities still reference this scope. Reparent or update them first.`,
        };
      }
    } finally {
      db.close();
    }
    try {
      await deleteScopeInDoco({ docoDir: dir, scopeId });
      await reindex(dir);
    } catch (e) {
      return { error: `Failed to delete: ${(e as Error).message}` };
    }
    return redirect(`/${ownerSlug}/${docoSlug}/e/scope`);
  }

  return { error: `Unknown intent: ${intent}` };
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
  const {
    ent,
    type,
    id,
    outgoing,
    incoming,
    ownerSlug,
    docoSlug,
    host,
    graphNodes,
    graphLinks,
    scopeLanding,
    allScopes,
    memberCount,
  } = loaderData;
  const display =
    (ent.slug as string | undefined) ??
    (ent.title as string | undefined) ??
    (ent.name as string | undefined) ??
    id;
  const linkTo = (kind: string, otherId: string) => `/${ownerSlug}/${docoSlug}/e/${kind}/${otherId}`;
  const [activeTab, setActiveTab] = useState<"details" | "map">("details");
  // Scope-edit mode: toggled inline. ADR-084 follow-up.
  const [editingPG, setEditingPG] = useState(false);
  const [editingParents, setEditingParents] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isScope = type === "scope";
  const currentParents = isScope && Array.isArray(ent.scopes) ? (ent.scopes as string[]) : [];
  const subScopeCount = scopeLanding?.subScopes.length ?? 0;

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

      {isScope ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Purpose &amp; guidelines</span>
              {editingPG ? null : (
                <button
                  type="button"
                  onClick={() => setEditingPG(true)}
                  className="rounded-md border border-border px-2 py-0.5 text-[10px] hover:border-primary"
                >
                  Edit
                </button>
              )}
            </CardTitle>
            <CardDescription>
              Per ADR-082 — what this scope is for and how to author nodes inside it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {editingPG ? (
              <Form method="post" className="space-y-2">
                <input type="hidden" name="intent" value="save_scope" />
                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">Purpose</span>
                  <textarea
                    name="purpose"
                    rows={3}
                    defaultValue={
                      typeof ent.purpose === "string" ? String(ent.purpose) : ""
                    }
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">Guidelines (markdown)</span>
                  <textarea
                    name="guidelines"
                    rows={10}
                    defaultValue={
                      typeof ent.guidelines === "string" ? String(ent.guidelines) : ""
                    }
                    className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
                  />
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingPG(false)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </Form>
            ) : (
              <>
                {typeof ent.purpose === "string" && ent.purpose ? (
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Purpose</p>
                    <p className="mt-1 text-xs">{String(ent.purpose)}</p>
                  </div>
                ) : null}
                {typeof ent.guidelines === "string" && ent.guidelines ? (
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Guidelines</p>
                    <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                      {String(ent.guidelines)}
                    </pre>
                  </div>
                ) : null}
                {!ent.purpose && !ent.guidelines ? (
                  <p className="text-xs text-muted-foreground">
                    No purpose or guidelines yet. Click Edit to add them.
                  </p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {scopeLanding ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Members of this scope</span>
              <Link
                to={`/${ownerSlug}/${docoSlug}/scopes/new?parent=${id}`}
                className="rounded-md border border-border px-2 py-0.5 text-[10px] hover:border-primary"
              >
                + Add child scope
              </Link>
            </CardTitle>
            <CardDescription>
              Per ADR-079 — entities that declare <code>scopes: [{id}]</code> in their
              frontmatter, grouped by node type.
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
                      to={linkTo("scope", s.id)}
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
                        to={linkTo(t, r.id)}
                        className="text-primary hover:underline font-mono text-[11px]"
                      >
                        {r.id.slice(0, 36)}
                      </Link>
                      {r.lifecycle ? <Badge>{r.lifecycle}</Badge> : null}
                      <span className="text-muted-foreground truncate">{r.summary}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to={`/${ownerSlug}/${docoSlug}/e/${t}?scope=${id}`}
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

      {isScope ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Manage scope</CardTitle>
            <CardDescription>
              Change parents (reparent) or remove this scope.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Reparent */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  Parents ({currentParents.length})
                </p>
                {editingParents ? null : (
                  <button
                    type="button"
                    onClick={() => setEditingParents(true)}
                    className="rounded-md border border-border px-2 py-0.5 text-[10px] hover:border-primary"
                  >
                    Reparent
                  </button>
                )}
              </div>
              {editingParents ? (
                <Form method="post" className="space-y-2">
                  <input type="hidden" name="intent" value="reparent" />
                  <p className="text-[11px] text-muted-foreground">
                    Pick zero or more parents. Multi-parent supported. Leaving
                    none makes this a root scope.
                  </p>
                  <div className="max-h-60 overflow-auto rounded-md border border-border p-2">
                    {allScopes.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No other scopes to choose from.
                      </p>
                    ) : (
                      allScopes.map((s) => (
                        <label
                          key={s.id}
                          className="flex items-center gap-2 py-0.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            name="parent_id"
                            value={s.id}
                            defaultChecked={currentParents.includes(s.id)}
                          />
                          <span className="font-mono">{s.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                    >
                      Save parents
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingParents(false)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </Form>
              ) : currentParents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Root scope (no parents).
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2 text-xs">
                  {currentParents.map((pid) => {
                    const p = allScopes.find((s) => s.id === pid);
                    return (
                      <li
                        key={pid}
                        className="rounded-full border border-border bg-card px-2 py-0.5 font-mono"
                      >
                        {p?.name ?? pid}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Delete */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Delete
              </p>
              {memberCount > 0 || subScopeCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Can't delete: this scope still has {memberCount}{" "}
                  {memberCount === 1 ? "member" : "members"}
                  {subScopeCount > 0
                    ? ` and ${subScopeCount} child ${subScopeCount === 1 ? "scope" : "scopes"}`
                    : ""}
                  . Reparent or remove references first.
                </p>
              ) : confirmingDelete ? (
                <Form method="post" className="space-y-2">
                  <input type="hidden" name="intent" value="delete" />
                  <p className="text-xs text-destructive">
                    This will permanently remove the scope file. Are you sure?
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:opacity-90"
                    >
                      Yes, delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </Form>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded-md border border-destructive px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                >
                  Delete this scope
                </button>
              )}
            </div>
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
                      <Link to={linkTo(e.to_node_type, e.to_id)} className="text-primary hover:underline">
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
                      <Link to={linkTo(e.from_node_type, e.from_id)} className="text-primary hover:underline">
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
        <EntityGraph
          centerId={id}
          nodes={graphNodes}
          links={graphLinks}
          hrefFor={(nid, nt) => linkTo(nt, nid)}
        />
      </CardContent>
    </Card>
  );

  return (
    <div>
      <SiteHeader context={host.name} mode="host" docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-7xl px-6 py-6">
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
