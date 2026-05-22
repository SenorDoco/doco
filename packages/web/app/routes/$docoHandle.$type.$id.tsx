import { withClient } from "@doco/db";
import { globalPageRank, personalizedPageRank } from "@doco/index";
import { ENTITY_TYPES, type EntityId, entityUrl, parseEntityId } from "@doco/shared";
// Per-Doco entity detail at the short URL `/:ownerSlug/:docoSlug/:type/:id`.
//
// Replaces the legacy `/e/:type/:id` URL — that path now redirects here.
// See `ship-short-entity-urls` Intent + ADR.
import { useState } from "react";
import { parse as parseYaml } from "yaml";
import { readEntityHistory } from "~/lib/audit-log.server";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";

/** External entity_type → PG table name. */
const TABLE_BY_TYPE: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  guidance_primitive: "guidance_primitives",
  neuron_authoring_primitive: "neuron_authoring_primitives",
  action: "actions",
  log: "logs",
  reference: "reference_entities",
  eval: "evals",
  idea: "ideas",
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State is a first-class
  // node type. The generic detail page handles it via this mapping;
  // the frontmatter renderer surfaces `kind` and `invariants`
  // alongside the standard summary / follows tail.
  state: "states",
  principal: "principals",
  organization: "organizations",
};

function tableFor(entityType: string): string {
  return TABLE_BY_TYPE[entityType] ?? entityType;
}

/** Tables that live at host level (no doco_id column). */
const HOST_LEVEL_TABLES = new Set(["principals", "organizations"]);

type IdentitySummary = {
  id: string;
  entity_type: "principal" | "organization";
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
  entityType: string,
  fm: Record<string, unknown>,
  createdBy: string | null,
): string | null {
  if (entityType === "intent") return stringField(fm, "wanted_by") ?? createdBy;
  if (entityType === "action" || entityType === "log") return stringField(fm, "actor_id") ?? createdBy;
  if (entityType === "decision") return stringField(fm, "decided_by") ?? createdBy;
  return createdBy;
}
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { EntityGraph, type GraphLink, type GraphNode } from "~/components/entity-graph";
import {
  type DrawerEdge,
  type DrawerKind,
  NeuronDetailDrawer,
} from "~/components/neuron-detail-drawer";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { SiteHeader } from "~/components/site-header";
import { lifecycleColor } from "~/lib/neuron-colors";

function prettyTypePlural(entityType: string): string {
  return `${entityType
    .split("_")
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ")}s`;
}

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
  const { type, id: idParam } = params;
  if (!KNOWN.has(type)) {
    throw new Response("Unknown type", { status: 404 });
  }
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const me = ctx.me;
  const docoId = ctx.meta.docoId;
  const dir = ctx.dir;

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
    }
    if (!row) throw new Response(`Not found: ${idParam}`, { status: 404 });
    const id = row.id;
    const ent = (parseYaml(row.raw_yaml) ?? {}) as Record<string, unknown>;

    const outgoing = (
      await c.query<{
        to_id: string;
        to_neuron_type: string;
        synapse_type: string;
      }>(
        `SELECT to_id, to_neuron_type, synapse_type
           FROM synapses
          WHERE from_id = $1 AND doco_id = $2
          ORDER BY synapse_type, to_id`,
        [id, docoId],
      )
    ).rows;
    const incoming = (
      await c.query<{
        from_id: string;
        from_neuron_type: string;
        synapse_type: string;
      }>(
        `SELECT from_id, from_neuron_type, synapse_type
           FROM synapses
          WHERE to_id = $1 AND doco_id = $2
          ORDER BY synapse_type, from_id`,
        [id, docoId],
      )
    ).rows;

    const allEdgesRows = (
      await c.query<{ from_id: string; to_id: string; synapse_type: string }>(
        "SELECT from_id, to_id, synapse_type FROM synapses WHERE doco_id = $1",
        [docoId],
      )
    ).rows;

    const graphEdgesRows = allEdgesRows;
    const pprEdges = graphEdgesRows.map((e) => ({
      from: e.from_id,
      to: e.to_id,
      synapse_type: e.synapse_type,
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
        entity_type: string;
        collaborator_id: string | null;
        principal_label: string | null;
      }
    >();
    for (const [tbl, ids] of neighborsByTable) {
      try {
        let sql: string;
        let params: unknown[];
        if (tbl === "principals") {
          sql = `SELECT id,
                        username AS label,
                        username AS name,
                        NULL::text AS lifecycle,
                        created_at::text,
                        id AS collaborator_id,
                        username AS principal_label,
                        NULL::text AS created_by,
                        raw_yaml
                   FROM principals
                  WHERE id = ANY($1::text[])`;
          params = [ids];
        } else if (tbl === "organizations") {
          sql = `SELECT id,
                        COALESCE(name, slug) AS label,
                        slug AS name,
                        NULL::text AS lifecycle,
                        created_at::text,
                        NULL::text AS collaborator_id,
                        NULL::text AS principal_label,
                        NULL::text AS created_by,
                        raw_yaml
                   FROM organizations
                  WHERE id = ANY($1::text[])`;
          params = [ids];
        } else {
          sql = `SELECT t.id,
                        t.summary AS label,
                        NULL::text AS name,
                        t.lifecycle,
                        t.created_at::text,
                        NULL::text AS collaborator_id,
                        NULL::text AS principal_label,
                        t.created_by,
                        t.raw_yaml
                   FROM ${tbl} t
                  WHERE t.id = ANY($1::text[]) AND t.doco_id = $2`;
          params = [ids, docoId];
        }
        const r = await c.query<{
          id: string;
          label: string | null;
          name: string | null;
          lifecycle: string | null;
          created_at: string | null;
          collaborator_id: string | null;
          principal_label: string | null;
          created_by: string | null;
          raw_yaml: string | null;
        }>(sql, params);
        for (const row of r.rows) {
          const m = /^([a-z_]+)_/.exec(row.id);
          const nt = m?.[1] ?? "";
          const fm = storedFrontmatter(row.raw_yaml);
          neighborMeta.set(row.id, {
            entity_type: nt,
            summary: row.label ?? row.id,
            name: row.name ?? null,
            lifecycle: row.lifecycle ?? null,
            created_at: row.created_at ?? null,
            collaborator_id: row.collaborator_id ?? graphLanePrincipalId(nt, fm, row.created_by ?? null),
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
          .map((meta) => meta.collaborator_id)
          .filter((principalId): principalId is string => Boolean(principalId)),
      ),
    );
    if (graphPrincipalIds.length > 0) {
      const principalRows = await c.query<{ id: string; label: string }>(
        "SELECT id, username AS label FROM principals WHERE id = ANY($1::text[])",
        [graphPrincipalIds],
      );
      const principalLabelById = new Map(principalRows.rows.map((row) => [row.id, row.label]));
      for (const meta of neighborMeta.values()) {
        if (!meta.collaborator_id || meta.principal_label) continue;
        meta.principal_label = principalLabelById.get(meta.collaborator_id) ?? null;
      }
    }
    // For every visible node, scan the audit log to find when it last
    // entered its current lifecycle stage. Used as the "X ago" timestamp
    // on each card (so the time reflects how long the node has been in
    // its current state, not when it was created). Nodes with no
    // lifecycle change in the audit trail fall back to `created_at`.
    const visibleIds = Array.from(neighborIds);
    const lifecycleSinceById = new Map<string, string>();
    const lifecycleHistoryById = new Map<
      string,
      { at: string; from: string | null; to: string }[]
    >();
    if (visibleIds.length > 0) {
      const auditRows = (
        await c.query<{
          entity_id: string;
          at: Date | string;
          before_json: unknown;
          after_json: unknown;
        }>(
          `SELECT entity_id, at, before_json, after_json
             FROM audit_events
            WHERE doco_id = $1 AND entity_id = ANY($2::text[])
            ORDER BY at DESC`,
          [docoId, visibleIds],
        )
      ).rows;
      for (const row of auditRows) {
        const before = (row.before_json ?? {}) as { lifecycle?: unknown };
        const after = (row.after_json ?? {}) as { lifecycle?: unknown };
        const beforeLc = typeof before.lifecycle === "string" ? before.lifecycle : null;
        const afterLc = typeof after.lifecycle === "string" ? after.lifecycle : null;
        if (!afterLc || beforeLc === afterLc) continue;
        const at = row.at instanceof Date ? row.at.toISOString() : String(row.at);
        const hist = lifecycleHistoryById.get(row.entity_id) ?? [];
        hist.push({ at, from: beforeLc, to: afterLc });
        lifecycleHistoryById.set(row.entity_id, hist);
        if (!lifecycleSinceById.has(row.entity_id)) {
          // ORDER BY at DESC means the first hit per entity is the most recent.
          lifecycleSinceById.set(row.entity_id, at);
        }
      }
    }

    const graphNodes: GraphNode[] = [];
    for (const nid of neighborIds) {
      const meta = neighborMeta.get(nid);
      const m = /^([a-z_]+)_/.exec(nid);
      const nt = meta?.entity_type ?? m?.[1] ?? "";
      if (!nt) continue;
      const lifecycleSince = lifecycleSinceById.get(nid) ?? meta?.created_at ?? null;
      graphNodes.push({
        id: nid,
        entity_type: nt,
        summary: meta?.summary ?? nid,
        name: meta?.name ?? null,
        lifecycle: meta?.lifecycle ?? null,
        collaborator_id: meta?.collaborator_id ?? (nt === "principal" ? nid : null),
        principal_label:
          meta?.principal_label ??
          (nt === "principal" ? (meta?.name ?? meta?.summary ?? nid) : null),
        created_at: meta?.created_at ?? null,
        lifecycle_since: lifecycleSince,
        ppr: pprByid.get(nid) ?? 0,
        gpr: gprByid.get(nid) ?? 0,
        is_center: nid === id,
      });
    }
    const focalLifecycleHistory = lifecycleHistoryById.get(id) ?? [];
    const graphLinks: GraphLink[] = graphEdgesRows
      .filter((e) => neighborIds.has(e.from_id) && neighborIds.has(e.to_id))
      .map((e) => ({
        source: e.from_id,
        target: e.to_id,
        synapse_type: e.synapse_type,
      }));

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
        identityMap[p.id] = {
          id: p.id,
          entity_type: "principal",
          label: p.username ?? p.id,
          detail: `${p.type} · ${p.username}`,
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
          entity_type: "organization",
          label: org.name ?? org.slug ?? org.id,
          detail: `organization · ${org.slug}`,
        };
      }
    }

    return {
      ent,
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
      me,
      history,
      identityMap,
      focalLifecycleHistory,
    };
  });
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
    type,
    id,
    outgoing,
    incoming,
    ownerSlug,
    docoSlug,
    handle,
    graphNodes,
    graphLinks,
    me,
    history,
    focalLifecycleHistory,
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
    entityUrl({ ownerSlug, docoSlug, entityType: kind, id: otherId });
  const [openDrawer, setOpenDrawer] = useState<DrawerKind | null>(null);

  // Focal node's GPR (computed in the loader for every neighbor including center).
  const focalNode = graphNodes.find((n) => n.is_center);
  const focalGpr = focalNode?.gpr ?? null;
  const focalCreatedAt =
    focalNode?.created_at ??
    (typeof ent.created_at === "string" ? (ent.created_at as string) : null);
  const focalLifecycle = typeof ent.lifecycle === "string" ? (ent.lifecycle as string) : null;
  const focalLifecycleSince = focalNode?.lifecycle_since ?? focalCreatedAt;

  // PPR-ranked neighbors for the Info pane — drop the focal, take the top 10.
  const rankedNeighbors = graphNodes
    .filter((n) => !n.is_center)
    .sort((a, b) => b.ppr - a.ppr)
    .slice(0, 10);

  const drawerOutgoing: DrawerEdge[] = outgoing.map((e) => ({
    synapse_type: e.synapse_type,
    other_id: e.to_id,
    other_neuron_type: e.to_neuron_type,
  }));
  const drawerIncoming: DrawerEdge[] = incoming.map((e) => ({
    synapse_type: e.synapse_type,
    other_id: e.from_id,
    other_neuron_type: e.from_neuron_type,
  }));
  const drawerHistory = history.map((e) => ({
    event_id: e.event_id,
    at: e.at,
    by: e.by ?? null,
    op: e.op,
    before: e.before,
    after: e.after,
  }));

  const drawerButtons: { kind: DrawerKind; label: string }[] = [
    { kind: "relevant", label: "Relevant neurons" },
    { kind: "synapses", label: "Synapses" },
    { kind: "history", label: "History" },
    { kind: "metadata", label: "Metadata" },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <SiteHeader mode="host" me={me} />

      <div className="shrink-0 border-b border-border bg-card px-4 py-2">
        <Breadcrumb
          items={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: prettyTypePlural(type), to: `/${handle}/${type}` },
            pageLabel: display,
          })}
          className="mb-1.5"
        />
        <div className="flex items-start gap-2">
          <NeuronTypeIcon
            entityType={type}
            aria-label={type}
            className="!h-5 !w-5 mt-0.5 shrink-0 text-foreground"
          />
          <h1 className="min-w-0 flex-1 break-words text-sm font-semibold tracking-tight text-foreground">
            <span className="uppercase tracking-wider">{type}:</span> {display}
          </h1>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-7 text-[11px]">
          {focalLifecycle ? (
            <span
              className="inline-flex items-center gap-1.5 font-medium"
              style={{ color: lifecycleColor(focalLifecycle) }}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: lifecycleColor(focalLifecycle) }}
              />
              <span className="uppercase tracking-wider">{focalLifecycle}</span>
              {focalLifecycleSince ? <span>· {relativeTimeIso(focalLifecycleSince)}</span> : null}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {drawerButtons.map((btn) => {
              const active = openDrawer === btn.kind;
              return (
                <button
                  key={btn.kind}
                  type="button"
                  onClick={() => setOpenDrawer(active ? null : btn.kind)}
                  className={
                    active
                      ? "rounded-md border border-primary bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-foreground"
                      : "rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  }
                  aria-pressed={active}
                >
                  {btn.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <section className="relative min-h-0 min-w-0 flex-1 p-3">
          <EntityGraph
            key={`${type}:${id}`}
            centerId={id}
            nodes={graphNodes}
            links={graphLinks}
            hrefFor={(nid, nt) => linkTo(nt, nid)}
            fillHeight
          />
          <NeuronDetailDrawer
            open={openDrawer}
            onClose={() => setOpenDrawer(null)}
            linkTo={linkTo}
            nodeId={id}
            nodeCreatedAt={focalCreatedAt}
            nodeGpr={focalGpr}
            rankedNeighbors={rankedNeighbors}
            outgoing={drawerOutgoing}
            incoming={drawerIncoming}
            history={drawerHistory}
            lifecycleHistory={focalLifecycleHistory}
            ent={ent}
          />
        </section>
      </div>
    </div>
  );
}
