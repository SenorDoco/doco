import { Link } from "react-router";
import { openDocoDb } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

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

interface ScopeRow {
  id: string;
  name: string;
  summary: string;
  purpose: string | null;
  parent_ids: string[];
  member_count: number;
  sub_scope_count: number;
}

interface ScopeTreeNode extends ScopeRow {
  children: ScopeTreeNode[];
  depth: number;
}

export function loader({
  params,
  request,
}: {
  params: { ownerSlug: string; docoSlug: string; type: string };
  request: Request;
}) {
  const { ownerSlug, docoSlug, type } = params;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  const db = openDocoDb(ownerSlug, docoSlug);
  try {
    if (type === "scope") {
      // ADR-084: scope list = tree view with member counts + parent edges.
      const rows = db
        .prepare(
          `SELECT s.id, s.name, s.summary, s.raw_json,
                  (SELECT COUNT(*) FROM edges e
                   WHERE e.to_id = s.id AND e.edge_type = 'in_scope_of'
                     AND e.from_node_type != 'scope') AS member_count,
                  (SELECT COUNT(*) FROM edges e
                   WHERE e.to_id = s.id AND e.edge_type = 'in_scope_of'
                     AND e.from_node_type = 'scope') AS sub_scope_count
           FROM scope s ORDER BY s.name`,
        )
        .all() as {
        id: string;
        name: string;
        summary: string;
        raw_json: string;
        member_count: number;
        sub_scope_count: number;
      }[];
      const scopes: ScopeRow[] = rows.map((r) => {
        const ent = JSON.parse(r.raw_json) as Record<string, unknown>;
        return {
          id: r.id,
          name: r.name,
          summary: r.summary,
          purpose: typeof ent.purpose === "string" ? ent.purpose : null,
          parent_ids: Array.isArray(ent.scopes) ? (ent.scopes as string[]) : [],
          member_count: r.member_count,
          sub_scope_count: r.sub_scope_count,
        };
      });
      return {
        items: [],
        scopes,
        type,
        ownerSlug,
        docoSlug,
        host: loadHostConfig(),
        me: getCurrentPrincipal(request),
      };
    }
    const rows = db
      .prepare(`SELECT id, summary, raw_json FROM ${type} ORDER BY id DESC LIMIT 200`)
      .all() as { id: string; summary: string; raw_json: string }[];
    const items = rows.map((r) => {
      const ent = JSON.parse(r.raw_json) as Record<string, unknown>;
      return {
        id: r.id,
        summary: r.summary,
        slug: (ent.slug as string | undefined) ?? null,
        title: (ent.title as string | undefined) ?? null,
        name: (ent.name as string | undefined) ?? null,
        number: (ent.number as string | undefined) ?? null,
      };
    });
    return {
      items,
      scopes: null,
      type,
      ownerSlug,
      docoSlug,
      host: loadHostConfig(),
      me: getCurrentPrincipal(request),
    };
  } finally {
    db.close();
  }
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string; type: string } }) {
  return [{ title: `${params.type}s · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

/** Build a forest of scope trees from a flat scope list. */
function buildScopeTree(scopes: ScopeRow[]): ScopeTreeNode[] {
  const byId = new Map<string, ScopeTreeNode>();
  for (const s of scopes) byId.set(s.id, { ...s, children: [], depth: 0 });
  const roots: ScopeTreeNode[] = [];
  for (const s of byId.values()) {
    if (s.parent_ids.length === 0) {
      roots.push(s);
    } else {
      // Use the first parent (multi-parent isn't tree-shaped; first wins for display).
      const parent = byId.get(s.parent_ids[0]!);
      if (parent) parent.children.push(s);
      else roots.push(s); // dangling parent: render at root
    }
  }
  // Assign depths.
  function assignDepths(nodes: ScopeTreeNode[], depth: number): void {
    for (const n of nodes) {
      n.depth = depth;
      assignDepths(n.children, depth + 1);
    }
  }
  assignDepths(roots, 0);
  // Sort each level by name.
  function sortRecursive(nodes: ScopeTreeNode[]): void {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortRecursive(n.children);
  }
  sortRecursive(roots);
  return roots;
}

function flattenTree(roots: ScopeTreeNode[]): ScopeTreeNode[] {
  const out: ScopeTreeNode[] = [];
  function walk(nodes: ScopeTreeNode[]): void {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  }
  walk(roots);
  return out;
}

export default function ListByTypeInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { items, scopes, type, ownerSlug, docoSlug, host, me } = loaderData;
  if (type === "scope" && scopes) {
    const tree = buildScopeTree(scopes);
    const flat = flattenTree(tree);
    return (
      <div>
        <SiteHeader
          context={host.name}
          mode="host"
          me={me}
          docoScope={{ ownerSlug, docoSlug }}
        />
        <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>
                  Scopes{" "}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    ({scopes.length})
                  </span>
                </span>
                <Link
                  to={`/${ownerSlug}/${docoSlug}/scopes/new`}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  + New scope
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {scopes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No scopes yet.{" "}
                  <Link
                    to={`/${ownerSlug}/${docoSlug}/scopes/new?onboarding=1`}
                    className="text-primary hover:underline"
                  >
                    Set up your first scopes
                  </Link>
                  .
                </p>
              ) : (
                <ul className="text-xs">
                  {flat.map((n) => (
                    <li
                      key={n.id}
                      className="flex items-baseline gap-2 border-b border-border py-1.5 last:border-0"
                      style={{ paddingLeft: `${n.depth * 1.25}rem` }}
                    >
                      {n.depth > 0 ? (
                        <span className="font-mono text-muted-foreground">└</span>
                      ) : null}
                      <Link
                        to={`/${ownerSlug}/${docoSlug}/e/scope/${n.id}`}
                        className="font-mono text-primary hover:underline"
                      >
                        {n.name}
                      </Link>
                      <span className="text-muted-foreground">
                        ({n.member_count}{" "}
                        {n.member_count === 1 ? "member" : "members"}
                        {n.sub_scope_count > 0
                          ? ` · ${n.sub_scope_count} ${n.sub_scope_count === 1 ? "child" : "children"}`
                          : ""}
                        )
                      </span>
                      {n.purpose ? (
                        <span className="ml-2 truncate text-muted-foreground">
                          — {n.purpose}
                        </span>
                      ) : null}
                      <Link
                        to={`/${ownerSlug}/${docoSlug}/scopes/new?parent=${n.id}`}
                        className="ml-auto rounded-md border border-border px-2 py-0.5 text-[10px] hover:border-primary"
                        title="Add child scope"
                      >
                        + child
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  // Generic non-scope rendering.
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {capitalize(type)}s{" "}
              <span className="ml-2 text-xs font-normal text-muted-foreground">({items.length})</span>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>id / slug</TableHead>
                <TableHead>summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.id}>
                  <TableCell>
                    <Link
                      to={`/${ownerSlug}/${docoSlug}/e/${type}/${it.id}`}
                      className="text-primary hover:underline"
                    >
                      {it.slug ?? it.title ?? it.name ?? it.id}
                    </Link>
                    {it.number ? (
                      <Badge variant="accent" className="ml-2">
                        {it.number}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </main>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
