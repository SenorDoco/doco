import { withClient } from "@doco/db";
import { globalPageRank, personalizedPageRank } from "@doco/index";
import { ENTITY_TYPES, type EntityId, entityListUrl, entityUrl, parseEntityId } from "@doco/shared";
// Per-Doco entity detail at the short URL `/:ownerSlug/:docoSlug/:type/:id`.
//
// Replaces the legacy `/e/:type/:id` URL — that path now redirects here.
// See `ship-short-entity-urls` Intent + ADR.
import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import { parse as parseYaml } from "yaml";
import { type AuditEvent, readEntityHistory } from "~/lib/audit-log.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { reindex, updateScopeInDoco } from "~/lib/redeem.server";

/** External node_type → PG table name. */
const TABLE_BY_TYPE: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  log: "logs",
  reference: "reference_entities",
  scope: "scopes",
  eval: "evals",
  idea: "ideas",
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State is a first-class
  // node type. The generic detail page handles it via this mapping;
  // the frontmatter renderer surfaces `kind` and `invariants`
  // alongside the standard summary / scopes / follows tail.
  state: "states",
  principal: "principals",
  organization: "organizations",
};

function tableFor(nodeType: string): string {
  return TABLE_BY_TYPE[nodeType] ?? nodeType;
}

/** Tables that live at host level (no doco_id column). */
const HOST_LEVEL_TABLES = new Set(["principals", "organizations"]);

type IdentitySummary = {
  id: string;
  node_type: "principal" | "organization";
  label: string;
  detail: string;
};

function collectIdentityIds(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const parsed = parseEntityId(value);
    if (parsed?.type === "principal" || parsed?.type === "organization") out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIdentityIds(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectIdentityIds(item, out);
    }
  }
  return out;
}

function displayPrincipalType(type: string): string {
  return type === "human" ? "person" : type;
}

function storedFrontmatter(rawYaml: string | null | undefined): Record<string, unknown> {
  if (!rawYaml) return {};
  try {
    const parsed = parseYaml(rawYaml);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(fm: Record<string, unknown>, field: string): string | null {
  const value = fm[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function graphLanePrincipalId(
  nodeType: string,
  fm: Record<string, unknown>,
  createdBy: string | null,
): string | null {
  if (nodeType === "intent") return stringField(fm, "wanted_by") ?? createdBy;
  if (nodeType === "action" || nodeType === "log") return stringField(fm, "actor_id") ?? createdBy;
  if (nodeType === "decision") return stringField(fm, "decided_by") ?? createdBy;
  return createdBy;
}
import { Badge, LifecycleBadge, NodeTypeBadge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { EntityGraph, type GraphLink, type GraphNode } from "~/components/entity-graph";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

/** "Ns / Nm / Nh / Nd ago" — same shape the graph component uses. */
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

const KNOWN = new Set<string>(ENTITY_TYPES);

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; type: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { type, id: idParam } = params;
  if (!KNOWN.has(type)) throw new Response("Unknown type", { status: 404 });
  // Per decision_01KRPNZY7W6CCMYNKGND67BP0B scopes use the plural URL
  // `/scopes/:id` so the merged detail+edit page is the single canonical
  // landing surface. Redirect the singular short-form here.
  if (type === "scope") {
    throw redirect(`/${handle}/scopes/${idParam}`, { status: 308 });
  }
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug);
  const me = ctx.me;
  const docoId = ctx.meta.docoId;
  const dir = docoPath(ownerSlug, docoSlug);

  return withClient(async (c) => {
    const table = tableFor(type);
    const hostLevel = HOST_LEVEL_TABLES.has(table);
    let row: { raw_yaml: string; id: string } | undefined;
    if (hostLevel) {
      row = (
        await c.query<{ raw_yaml: string; id: string }>(
          `SELECT raw_yaml, id FROM ${table} WHERE id = $1`,
          [idParam],
        )
      ).rows[0];
    } else {
      row = (
        await c.query<{ raw_yaml: string; id: string }>(
          `SELECT raw_yaml, id FROM ${table} WHERE id = $1 AND doco_id = $2`,
          [idParam, docoId],
        )
      ).rows[0];
      if (!row && type === "scope") {
        row = (
          await c.query<{ raw_yaml: string; id: string }>(
            "SELECT raw_yaml, id FROM scopes WHERE name = $1 AND doco_id = $2",
            [idParam, docoId],
          )
        ).rows[0];
      }
    }
    if (!row) throw new Response(`Not found: ${idParam}`, { status: 404 });
    const id = row.id;
    const ent = (parseYaml(row.raw_yaml) ?? {}) as Record<string, unknown>;

    const entityScopeIds = Array.isArray(ent.scopes) ? (ent.scopes as string[]) : [];
    const entityScopes: { id: string; name: string; icon: string | null }[] = [];
    if (entityScopeIds.length > 0) {
      const r = await c.query<{ id: string; name: string; raw_yaml: string }>(
        "SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1 AND id = ANY($2::text[])",
        [docoId, entityScopeIds],
      );
      const byId = new Map(r.rows.map((s) => [s.id, s]));
      for (const sid of entityScopeIds) {
        const s = byId.get(sid);
        if (!s) continue;
        let icon: string | null = null;
        try {
          const parsed = parseYaml(s.raw_yaml) as { icon?: string } | null;
          if (parsed && typeof parsed.icon === "string") icon = parsed.icon;
        } catch {}
        entityScopes.push({ id: s.id, name: s.name, icon });
      }
    }

    const outgoing = (
      await c.query<{
        to_id: string;
        to_node_type: string;
        edge_type: string;
        attribution: string;
      }>(
        `SELECT to_id, to_node_type, edge_type, attribution
           FROM edges
          WHERE from_id = $1 AND doco_id = $2
          ORDER BY edge_type, to_id`,
        [id, docoId],
      )
    ).rows;
    const incoming = (
      await c.query<{
        from_id: string;
        from_node_type: string;
        edge_type: string;
        attribution: string;
      }>(
        `SELECT from_id, from_node_type, edge_type, attribution
           FROM edges
          WHERE to_id = $1 AND doco_id = $2
          ORDER BY edge_type, from_id`,
        [id, docoId],
      )
    ).rows;

    const allEdgesRows = (
      await c.query<{ from_id: string; to_id: string; edge_type: string; attribution: string }>(
        "SELECT from_id, to_id, edge_type, attribution FROM edges WHERE doco_id = $1",
        [docoId],
      )
    ).rows;

    const graphEdgesRows = allEdgesRows;
    const pprEdges = graphEdgesRows.map((e) => ({
      from: e.from_id,
      to: e.to_id,
      edge_type: e.edge_type,
      attribution: e.attribution as "explicit" | "doco-auto",
    }));
    const ppr = personalizedPageRank(pprEdges, id, { topK: 25, alpha: 0.85 });
    const neighborIds = new Set([id, ...ppr.map((p) => p.id)]);
    const pprByid = new Map<string, number>([[id, 1]]);
    for (const p of ppr) pprByid.set(p.id, p.score);
    const gpr = globalPageRank(pprEdges, { alpha: 0.85 });
    const gprByid = new Map<string, number>();
    for (const p of gpr) gprByid.set(p.id, p.score);

    // Hydrate neighbors. Group ids by table for one query per table.
    const neighborsByTable = new Map<string, string[]>();
    for (const nid of neighborIds) {
      const m = /^([a-z_]+)_/.exec(nid);
      const nt = m?.[1];
      if (!nt) continue;
      const tbl = tableFor(nt);
      const arr = neighborsByTable.get(tbl) ?? [];
      arr.push(nid);
      neighborsByTable.set(tbl, arr);
    }
    const neighborMeta = new Map<
      string,
      {
        summary: string;
        name: string | null;
        lifecycle: string | null;
        created_at: string | null;
        node_type: string;
        principal_id: string | null;
        principal_label: string | null;
      }
    >();
    for (const [tbl, ids] of neighborsByTable) {
      try {
        let sql: string;
        let params: unknown[];
        if (tbl === "principals") {
          sql = `SELECT id,
                        COALESCE(display_name, username) AS summary,
                        COALESCE(display_name, username) AS name,
                        NULL::text AS lifecycle,
                        created_at::text,
                        id AS principal_id,
                        COALESCE(display_name, username) AS principal_label,
                        NULL::text AS created_by,
                        raw_yaml
                   FROM principals
                  WHERE id = ANY($1::text[])`;
          params = [ids];
        } else if (tbl === "organizations") {
          sql = `SELECT id,
                        COALESCE(name, slug) AS summary,
                        slug AS name,
                        NULL::text AS lifecycle,
                        created_at::text,
                        NULL::text AS principal_id,
                        NULL::text AS principal_label,
                        NULL::text AS created_by,
                        raw_yaml
                   FROM organizations
                  WHERE id = ANY($1::text[])`;
          params = [ids];
        } else {
          const nameExpr = tbl === "scopes" ? "t.name" : "NULL::text";
          sql = `SELECT t.id,
                        t.summary,
                        ${nameExpr} AS name,
                        t.lifecycle,
                        t.created_at::text,
                        NULL::text AS principal_id,
                        NULL::text AS principal_label,
                        t.created_by,
                        t.raw_yaml
                   FROM ${tbl} t
                  WHERE t.id = ANY($1::text[]) AND t.doco_id = $2`;
          params = [ids, docoId];
        }
        const r = await c.query<{
          id: string;
          summary: string | null;
          name: string | null;
          lifecycle: string | null;
          created_at: string | null;
          principal_id: string | null;
          principal_label: string | null;
          created_by: string | null;
          raw_yaml: string | null;
        }>(sql, params);
        for (const row of r.rows) {
          const m = /^([a-z_]+)_/.exec(row.id);
          const nt = m?.[1] ?? "";
          const fm = storedFrontmatter(row.raw_yaml);
          neighborMeta.set(row.id, {
            node_type: nt,
            summary: row.summary ?? row.id,
            name: row.name ?? null,
            lifecycle: row.lifecycle ?? null,
            created_at: row.created_at ?? null,
            principal_id: row.principal_id ?? graphLanePrincipalId(nt, fm, row.created_by ?? null),
            principal_label: row.principal_label ?? null,
          });
        }
      } catch {
        /* unknown table */
      }
    }
    const graphPrincipalIds = Array.from(
      new Set(
        Array.from(neighborMeta.values())
          .map((meta) => meta.principal_id)
          .filter((principalId): principalId is string => Boolean(principalId)),
      ),
    );
    if (graphPrincipalIds.length > 0) {
      const principalRows = await c.query<{ id: string; label: string }>(
        "SELECT id, COALESCE(display_name, username) AS label FROM principals WHERE id = ANY($1::text[])",
        [graphPrincipalIds],
      );
      const principalLabelById = new Map(principalRows.rows.map((row) => [row.id, row.label]));
      for (const meta of neighborMeta.values()) {
        if (!meta.principal_id || meta.principal_label) continue;
        meta.principal_label = principalLabelById.get(meta.principal_id) ?? null;
      }
    }
    const scopeIdsByNode = new Map<string, Set<string>>();
    const graphScopeIds = new Set<string>();
    for (const edge of allEdgesRows) {
      if (edge.edge_type !== "in_scope_of") continue;
      if (!neighborIds.has(edge.from_id)) continue;
      if (!edge.to_id.startsWith("scope_")) continue;
      const ids = scopeIdsByNode.get(edge.from_id) ?? new Set<string>();
      ids.add(edge.to_id);
      scopeIdsByNode.set(edge.from_id, ids);
      graphScopeIds.add(edge.to_id);
    }
    for (const scope of entityScopes) {
      graphScopeIds.add(scope.id);
      if (id) {
        const ids = scopeIdsByNode.get(id) ?? new Set<string>();
        ids.add(scope.id);
        scopeIdsByNode.set(id, ids);
      }
    }
    const graphScopeById = new Map<string, { id: string; name: string; icon: string | null }>();
    if (graphScopeIds.size > 0) {
      const r = await c.query<{ id: string; name: string; raw_yaml: string }>(
        "SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1 AND id = ANY($2::text[])",
        [docoId, Array.from(graphScopeIds)],
      );
      for (const scope of r.rows) {
        let icon: string | null = null;
        try {
          const parsed = parseYaml(scope.raw_yaml) as { icon?: string } | null;
          if (parsed && typeof parsed.icon === "string") icon = parsed.icon;
        } catch {}
        graphScopeById.set(scope.id, { id: scope.id, name: scope.name, icon });
      }
    }
    const graphNodes: GraphNode[] = [];
    for (const nid of neighborIds) {
      const meta = neighborMeta.get(nid);
      const m = /^([a-z_]+)_/.exec(nid);
      const nt = meta?.node_type ?? m?.[1] ?? "";
      if (!nt) continue;
      graphNodes.push({
        id: nid,
        node_type: nt,
        summary: meta?.summary ?? nid,
        name: meta?.name ?? null,
        lifecycle: meta?.lifecycle ?? null,
        scopes: Array.from(scopeIdsByNode.get(nid) ?? [])
          .map((scopeId) => graphScopeById.get(scopeId))
          .filter((scope): scope is { id: string; name: string; icon: string | null } =>
            Boolean(scope),
          ),
        principal_id: meta?.principal_id ?? (nt === "principal" ? nid : null),
        principal_label:
          meta?.principal_label ??
          (nt === "principal" ? (meta?.name ?? meta?.summary ?? nid) : null),
        created_at: meta?.created_at ?? null,
        ppr: pprByid.get(nid) ?? 0,
        gpr: gprByid.get(nid) ?? 0,
        is_center: nid === id,
      });
    }
    const graphLinks: GraphLink[] = graphEdgesRows
      .filter((e) => neighborIds.has(e.from_id) && neighborIds.has(e.to_id))
      .map((e) => ({
        source: e.from_id,
        target: e.to_id,
        edge_type: e.edge_type,
        attribution: (e.attribution as "explicit" | "doco-auto") ?? "explicit",
      }));

    let scopeLanding: {
      members: Record<string, { id: string; summary: string; lifecycle: string | null }[]>;
      subScopes: { id: string; name: string }[];
    } | null = null;
    if (type === "scope") {
      const memberTypes = ["intent", "decision", "action", "rule", "idea"] as const;
      const members: Record<string, { id: string; summary: string; lifecycle: string | null }[]> =
        {};
      for (const t of memberTypes) {
        const memTable = tableFor(t);
        const rows = (
          await c.query<{ id: string; summary: string; lifecycle: string | null }>(
            `SELECT t.id, t.summary, t.lifecycle
               FROM ${memTable} t
               JOIN edges e ON e.from_id = t.id
                           AND e.edge_type = 'in_scope_of'
                           AND e.to_id = $1
              WHERE t.doco_id = $2
              ORDER BY t.id DESC LIMIT 25`,
            [id, docoId],
          )
        ).rows;
        if (rows.length > 0) members[t] = rows;
      }
      const subScopes = (
        await c.query<{ id: string; name: string }>(
          `SELECT s.id, s.name FROM scopes s
             JOIN edges e ON e.from_id = s.id
                         AND e.edge_type = 'in_scope_of'
                         AND e.from_node_type = 'scope'
                         AND e.to_id = $1
            WHERE s.doco_id = $2
            ORDER BY s.name`,
          [id, docoId],
        )
      ).rows;
      scopeLanding = { members, subScopes };
    }

    let allScopes: { id: string; name: string }[] = [];
    if (type === "scope") {
      allScopes = (
        await c.query<{ id: string; name: string }>(
          "SELECT id, name FROM scopes WHERE doco_id = $1 AND id != $2 ORDER BY name",
          [docoId, id],
        )
      ).rows;
    }

    const history = await readEntityHistory(
      dir,
      id,
      50,
      typeof (ent as { doco_id?: string }).doco_id === "string"
        ? (ent as { doco_id: string }).doco_id
        : undefined,
    );
    const identityIds = collectIdentityIds(ent);
    collectIdentityIds(history, identityIds);
    for (const e of outgoing) collectIdentityIds(e.to_id, identityIds);
    for (const e of incoming) collectIdentityIds(e.from_id, identityIds);

    const identityMap: Record<string, IdentitySummary> = {};
    const principalIds = [...identityIds].filter(
      (candidate) => parseEntityId(candidate)?.type === "principal",
    );
    if (principalIds.length > 0) {
      const principals = (
        await c.query<{
          id: string;
          username: string;
          type: string;
        }>(
          `SELECT id, username, type
             FROM principals
            WHERE id = ANY($1::text[])`,
          [principalIds],
        )
      ).rows;
      for (const p of principals) {
        const kind = displayPrincipalType(p.type);
        identityMap[p.id] = {
          id: p.id,
          node_type: "principal",
          label: p.username ?? p.id,
          detail: `${kind} · ${p.username}`,
        };
      }
    }
    const organizationIds = [...identityIds].filter(
      (candidate) => parseEntityId(candidate)?.type === "organization",
    );
    if (organizationIds.length > 0) {
      const organizations = (
        await c.query<{
          id: string;
          slug: string;
          name: string | null;
        }>(
          `SELECT id, slug, name
             FROM organizations
            WHERE id = ANY($1::text[])`,
          [organizationIds],
        )
      ).rows;
      for (const org of organizations) {
        identityMap[org.id] = {
          id: org.id,
          node_type: "organization",
          label: org.name ?? org.slug ?? org.id,
          detail: `organization · ${org.slug}`,
        };
      }
    }

    return {
      ent,
      entityScopes,
      outgoing,
      incoming,
      type,
      id,
      ownerSlug,
      docoSlug,
      handle,
      host: await loadHostConfig(),
      graphNodes,
      graphLinks,
      scopeLanding,
      allScopes,
      me,
      history,
      identityMap,
    };
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; type: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { type, id } = params;
  if (type !== "scope") {
    return { error: "Inline edit is only supported for scopes today." };
  }
  await loadDocoForAdmin(request, ownerSlug, docoSlug); // 404/403 if not owner/admin
  const dir = docoPath(ownerSlug, docoSlug);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scopeId = id as EntityId<"scope">;

  // Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA `purpose` and `guidelines`
  // were removed; the "save_scope" intent went with them. To edit a
  // scope's rules, the user opens /scopes/<id>/edit (the only place rules
  // are managed).

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
    return redirect(entityUrl({ ownerSlug, docoSlug, nodeType: "scope", id: id }));
  }

  // Scope deletion is intentionally NOT handled here — it lives only in
  // the Danger Zone at the bottom of /scopes/<id>/edit, so the act of
  // destroying a scope requires opening its edit page first.

  return { error: `Unknown intent: ${intent}` };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Entity · Doco" }];
  const display =
    (data.ent.title as string | undefined) ??
    (data.ent.name as string | undefined) ??
    (data.ent.summary as string | undefined) ??
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
    entityScopes,
    type,
    id,
    outgoing,
    incoming,
    ownerSlug,
    docoSlug,
    handle,
    host,
    graphNodes,
    graphLinks,
    scopeLanding,
    allScopes,
    me,
    history,
    identityMap,
  } = loaderData;
  // Per ADR-018 each node type has its own handle field — username, name,
  // title, locator. Fall through to anything that reads as friendly
  // before giving up to the ULID. Entities no longer carry a slug.
  const display =
    (ent.username as string | undefined) ??
    (ent.display_name as string | undefined) ??
    (ent.name as string | undefined) ??
    (ent.title as string | undefined) ??
    (ent.locator as string | undefined) ??
    (ent.summary as string | undefined) ??
    id;
  const linkTo = (kind: string, otherId: string) =>
    entityUrl({ ownerSlug, docoSlug, nodeType: kind, id: otherId });
  // Scope-edit mode: toggled inline. ADR-084 follow-up. Deletion lives on
  // /scopes/<id>/edit's Danger Zone, not here.
  const [editingParents, setEditingParents] = useState(false);
  const isScope = type === "scope";
  const currentParents = isScope && Array.isArray(ent.scopes) ? (ent.scopes as string[]) : [];

  // Focal node's GPR (computed in the loader for every neighbor including center).
  const focalNode = graphNodes.find((n) => n.is_center);
  const focalGpr = focalNode?.gpr ?? null;
  const focalCreatedAt =
    focalNode?.created_at ??
    (typeof ent.created_at === "string" ? (ent.created_at as string) : null);

  // PPR-ranked neighbors for the "More relevant nodes" list — drop the focal,
  // take the top 10, render in descending order.
  const rankedNeighbors = graphNodes
    .filter((n) => !n.is_center)
    .sort((a, b) => b.ppr - a.ppr)
    .slice(0, 10);

  const headerPane = (
    <header className="space-y-2">
      <h1 className="text-lg font-semibold tracking-tight text-foreground">{display}</h1>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <NodeTypeBadge nodeType={type} />
        {ent.lifecycle ? <LifecycleBadge lifecycle={String(ent.lifecycle)} /> : null}
        {ent.modality ? <Badge variant="primary">{String(ent.modality)}</Badge> : null}
        {ent.phase ? <Badge variant="primary">{String(ent.phase)}</Badge> : null}
        {entityScopes.map((s) => (
          <Link
            key={s.id}
            to={linkTo("scope", s.name)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-mono text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            {s.icon ? (
              <span aria-hidden className="font-sans text-[12px] leading-none">
                {s.icon}
              </span>
            ) : null}
            <span>{s.name}</span>
          </Link>
        ))}
      </div>
      {ent.summary && String(ent.summary) !== display ? (
        <p className="max-w-4xl text-sm text-muted-foreground">{String(ent.summary)}</p>
      ) : null}
    </header>
  );

  const focalStatsPane = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">This node</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Id</dt>
          <dd
            className="font-mono break-all"
            title="Entity ULID id — primary key in this Doco's storage"
          >
            {id}
          </dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="font-mono">
            {focalCreatedAt ? `${focalCreatedAt} · ${relativeTimeIso(focalCreatedAt)}` : "—"}
          </dd>
          <dt className="text-muted-foreground">Global PageRank</dt>
          <dd className="font-mono">{focalGpr !== null ? focalGpr.toFixed(4) : "—"}</dd>
        </dl>
      </CardContent>
    </Card>
  );

  const relevantNodesPane = (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">More relevant nodes ({rankedNeighbors.length})</CardTitle>
        <CardDescription>Sorted by personalized PageRank from this node (ADR-076).</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {rankedNeighbors.map((n) => (
            <li key={n.id}>
              <Link
                to={linkTo(n.node_type, n.id)}
                className="block px-4 py-2 text-xs hover:bg-input/40"
              >
                <NodeTypeBadge nodeType={n.node_type} className="text-[10px] uppercase" />
                <span className="ml-2 font-mono text-foreground">{n.name ?? n.id}</span>
                <span className="ml-2 text-muted-foreground">{n.summary?.slice(0, 80)}</span>
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                  PPR {n.ppr.toFixed(3)} · GPR {n.gpr.toFixed(3)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );

  const detailsPane = (
    <div className="space-y-4">
      {isScope ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Rules</CardTitle>
            <CardDescription>
              Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA every piece of normative content on a scope —
              authoring predicates and agent-facing guidance — lives as a rule. Manage them on the
              scope edit page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to={`/${handle}/scopes/${id}/edit`}
              className="inline-flex items-center rounded-md border border-border bg-input px-3 py-1.5 text-xs font-semibold hover:bg-card"
            >
              Edit rules →
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {scopeLanding ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Members of this scope</span>
              <Link
                to={`/${handle}/scopes/new?parent=${id}`}
                className="rounded-md border border-border px-2 py-0.5 text-[10px] hover:border-primary"
              >
                + Add child scope
              </Link>
            </CardTitle>
            <CardDescription>
              Per ADR-079 — entities that declare <code>scopes: [{id}]</code> in their frontmatter,
              grouped by node type.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scopeLanding.subScopes.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Sub-scopes</p>
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
                  to={`${entityListUrl({ ownerSlug, docoSlug, nodeType: t })}?scope=${id}`}
                  className="mt-1 inline-block text-[11px] text-primary hover:underline"
                >
                  See all {t}s in this scope →
                </Link>
              </div>
            ))}
            {Object.keys(scopeLanding.members).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No members yet. Reference this scope from any entity's <code>scopes:</code> array to
                populate the dashboard.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {isScope ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Manage scope</CardTitle>
            <CardDescription>Change parents (reparent) or remove this scope.</CardDescription>
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
                    Pick zero or more parents. Multi-parent supported. Leaving none makes this a
                    root scope.
                  </p>
                  <div className="max-h-60 overflow-auto rounded-md border border-border p-2">
                    {allScopes.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No other scopes to choose from.
                      </p>
                    ) : (
                      allScopes.map((s) => (
                        <label key={s.id} className="flex items-center gap-2 py-0.5 text-xs">
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
                <p className="text-xs text-muted-foreground">Root scope (no parents).</p>
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

            <p className="text-[11px] text-muted-foreground">
              To delete this scope, open its{" "}
              <Link to={`/${handle}/scopes/${id}/edit`} className="underline hover:text-foreground">
                edit page
              </Link>{" "}
              and use the Danger Zone at the bottom.
            </p>
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
                      <Link
                        to={linkTo(e.to_node_type, e.to_id)}
                        className="text-primary hover:underline"
                      >
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
          <CardTitle className="text-sm">Referenced by ({incoming.length})</CardTitle>
          <CardDescription>
            Other entities that point at this one. Per ADR-075. A zero count is a hint that this
            entity may be isolated — consider whether it should be linked from an Action, Decision,
            or other contextual node.
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
                      <Link
                        to={linkTo(e.from_node_type, e.from_id)}
                        className="text-primary hover:underline"
                      >
                        {e.from_id}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({e.from_node_type})
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <HistoryCard history={history} identityMap={identityMap} linkTo={linkTo} />

      <MetadataCard ent={ent} identityMap={identityMap} linkTo={linkTo} />
    </div>
  );

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-7xl space-y-4 px-6 py-6">
        {/* 1. Header (no box) — id, title, badges, summary. */}
        {headerPane}

        {/* 2. The map — takes ~75% of viewport height (size lives in EntityGraph). */}
        <EntityGraph
          key={`${type}:${id}`}
          centerId={id}
          nodes={graphNodes}
          links={graphLinks}
          scopeFilters={entityScopes}
          hrefFor={(nid, nt) => linkTo(nt, nid)}
        />

        {/* 3. Stats + most-relevant-nodes side-by-side on desktop, stacked on mobile. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-1">{focalStatsPane}</div>
          <div className="md:col-span-2">{relevantNodesPane}</div>
        </div>

        {/* 4. Everything else (edges, scope landing, raw, refbacks). */}
        {detailsPane}
      </main>
    </div>
  );
}

type EntityLinkFn = (kind: string, otherId: string) => string;

function MetadataCard({
  ent,
  identityMap,
  linkTo,
}: {
  ent: Record<string, unknown>;
  identityMap: Record<string, IdentitySummary>;
  linkTo: EntityLinkFn;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Metadata</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border text-xs">
          {Object.entries(ent).map(([key, value]) => (
            <div key={key} className="grid gap-2 py-2 md:grid-cols-[12rem_1fr]">
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0">
                <MetadataValue value={value} identityMap={identityMap} linkTo={linkTo} />
              </dd>
            </div>
          ))}
        </dl>
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Raw JSON
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-input p-3 text-[12px] leading-snug">
            {JSON.stringify(ent, null, 2)}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

function MetadataValue({
  value,
  identityMap,
  linkTo,
}: {
  value: unknown;
  identityMap: Record<string, IdentitySummary>;
  linkTo: EntityLinkFn;
}) {
  if (value === null) return <code className="font-mono text-muted-foreground">null</code>;
  if (value === undefined)
    return <code className="font-mono text-muted-foreground">undefined</code>;

  if (typeof value === "string") {
    return <StringMetadataValue value={value} identityMap={identityMap} linkTo={linkTo} />;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return <code className="font-mono">{String(value)}</code>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <code className="font-mono text-muted-foreground">[]</code>;
    return (
      <ul className="space-y-1">
        {value.map((item) => (
          <li key={metadataItemKey(item)} className="min-w-0">
            <MetadataValue value={item} identityMap={identityMap} linkTo={linkTo} />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0)
      return <code className="font-mono text-muted-foreground">{"{}"}</code>;
    return (
      <dl className="space-y-1 rounded-md border border-border bg-input/30 p-2">
        {entries.map(([key, nested]) => (
          <div key={key} className="grid gap-1 md:grid-cols-[10rem_1fr]">
            <dt className="font-mono text-muted-foreground">{key}</dt>
            <dd className="min-w-0">
              <MetadataValue value={nested} identityMap={identityMap} linkTo={linkTo} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span className="break-words">{String(value)}</span>;
}

function metadataItemKey(item: unknown): string {
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
    return `${typeof item}:${String(item)}`;
  }
  if (item === null) return "null";
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record.id === "string") return record.id;
    if (typeof record.name === "string") return record.name;
    return JSON.stringify(record);
  }
  return String(item);
}

function StringMetadataValue({
  value,
  identityMap,
  linkTo,
}: {
  value: string;
  identityMap: Record<string, IdentitySummary>;
  linkTo: EntityLinkFn;
}) {
  const identity = identityMap[value];
  if (identity) return <IdentityValue identity={identity} linkTo={linkTo} />;

  const parsed = parseEntityId(value);
  if (parsed && parsed.type !== "doco") {
    return (
      <Link to={linkTo(parsed.type, value)} className="font-mono text-primary hover:underline">
        {value}
      </Link>
    );
  }

  return <span className="whitespace-pre-wrap break-words">{value}</span>;
}

function IdentityValue({
  identity,
  linkTo,
}: {
  identity: IdentitySummary;
  linkTo: EntityLinkFn;
}) {
  return (
    <span className="inline-flex max-w-full flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-2">
      <Link
        to={linkTo(identity.node_type, identity.id)}
        className="font-medium text-primary hover:underline"
      >
        {identity.label}
      </Link>
      <span className="text-muted-foreground">{identity.detail}</span>
      <code className="break-all font-mono text-[10px] text-muted-foreground" title={identity.id}>
        {identity.id}
      </code>
    </span>
  );
}

function HistoryCard({
  history,
  identityMap,
  linkTo,
}: {
  history: AuditEvent[];
  identityMap: Record<string, IdentitySummary>;
  linkTo: EntityLinkFn;
}) {
  if (!history || history.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">History</CardTitle>
          <CardDescription>
            Audit events captured for this entity. None yet — the audit log started recording on the
            day this Doco picked up the audit-events feature.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">History ({history.length})</CardTitle>
        <CardDescription>
          Audit events for this entity, newest first. From{" "}
          <code>/api/audit.json?entity_id=...</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2 text-xs">
          {history.map((e) => (
            <li key={e.event_id} className="border-l-2 border-border pl-3">
              <div className="text-muted-foreground">
                <code className="font-mono">{e.at.replace("T", " ").slice(0, 19)}Z</code>
                <span className="mx-2">·</span>
                {e.by ? (
                  <StringMetadataValue value={e.by} identityMap={identityMap} linkTo={linkTo} />
                ) : (
                  <code className="font-mono">anonymous</code>
                )}
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
      </CardContent>
    </Card>
  );
}
