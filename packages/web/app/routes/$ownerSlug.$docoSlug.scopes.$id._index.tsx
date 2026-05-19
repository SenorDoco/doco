// /<doco-handle>/scopes/<id> — merged scope detail + edit page.
//
// Per decision_01KRPNZY7W6CCMYNKGND67BP0B the separate detail and edit
// pages collapsed into this one. Per
// decision_01KRPRDR1AD7S1RP6E69BQDB2G scope rules are first-class Rule
// entities: rows in the `rules` table with an `in_scope_of` edge to this
// scope. This page surfaces Authoring + Guidance rules; other Rule
// entities tagged with the scope remain regular members/feed items.
// Abandon / activate is a regular Rule PATCH (lifecycle = abandoned / active).
//
// Layout: title-level icon picker, then two columns. Left carries Members
// stats + Watched toggle + Guidance/Authoring rule sections with standalone
// add links + Abandon scope link. Right carries activity heatmap +
// scope-filtered latest activity feed.

import { withClient } from "@doco/db";
import type { EntityId } from "@doco/shared";
import { entityUrl } from "@doco/shared";
import { Pencil, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Form,
  Link,
  type ShouldRevalidateFunctionArgs,
  redirect,
  useFetcher,
  useRevalidator,
} from "react-router";
import { parse as parseYaml } from "yaml";
import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { EmojiPickerInput } from "~/components/emoji-picker-input";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { NodesOverviewCard, type NodesOverviewSection } from "~/components/nodes-overview-card";
import { SiteHeader } from "~/components/site-header";
import { Toggle } from "~/components/toggle";
import { updateEntity } from "~/lib/capture.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { lifecycleColor } from "~/lib/node-colors";
import { reindex, setScopeWatchedInDoco, updateScopeInDoco } from "~/lib/redeem.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";
import { timeAgo } from "~/lib/time-ago";

const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;

interface TopContributor {
  principalId: string;
  username: string;
  lastAt: string;
  eventCount: number;
}

type RuleKind = "authoring" | "guidance" | "tagged";

interface AuthoringPredicateRecord {
  kind: string;
  edge_type?: string;
  target_node_type?: string;
  fields?: string[];
  field?: string;
  scope_ids?: string[];
  scope_id?: string;
  spec?: string;
  /**
   * Optional per-rule node-type filter
   * (decision_01KRRD5SRX69P2MWN0G1B8216H). Present on
   * `requires_edge` / `forbids_edge` / `requires_field` / `forbids_field`
   * predicates that should fire only for matching node types. Omitted
   * means scope-wide.
   */
  when_node_type?: string[];
  node_types?: string[];
}

interface RuleRecord {
  id: string;
  summary: string;
  lifecycle: string;
  kind: RuleKind;
  createdAt: string | null;
  predicate?: AuthoringPredicateRecord;
}

interface RuleLifecycleActionResult {
  ok?: boolean;
  rule_id?: string;
  lifecycle?: string;
  error?: string;
}

function asFieldList(p: AuthoringPredicateRecord): string[] {
  if (Array.isArray(p.fields)) return p.fields.filter((f): f is string => typeof f === "string");
  if (typeof p.field === "string" && p.field.length > 0) return [p.field];
  return [];
}

function asScopeIdList(p: AuthoringPredicateRecord): string[] {
  if (Array.isArray(p.scope_ids))
    return p.scope_ids.filter((s): s is string => typeof s === "string");
  if (typeof p.scope_id === "string" && p.scope_id.length > 0) return [p.scope_id];
  return [];
}

function isActive(lifecycle: string): boolean {
  return lifecycle === "active" || lifecycle === "proposed";
}

function inScopeSearchPath(
  handle: string,
  scopeName: string,
  filters: { nodeType?: string; lifecycle?: string },
): string {
  const params = new URLSearchParams();
  params.set("scope", scopeName);
  params.set("node_type", filters.nodeType ?? "*");
  params.set("lifecycle", filters.lifecycle ?? "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  decision: "Decisions",
  action: "Actions",
  intent: "Intents",
  rule: "Rules",
  scope: "Scopes",
  eval: "Evals",
  reference: "References",
  idea: "Ideas",
};

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}s`;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function readScopeRaw(scopeId: string): Promise<Record<string, unknown> | null> {
  try {
    return await withClient(async (c) => {
      const r = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
        [scopeId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return parseYaml(row.raw_yaml) as Record<string, unknown>;
    });
  } catch {
    return null;
  }
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  const { dir, me } = await loadDocoForAdmin(request, handle);
  const raw = await readScopeRaw(id);
  if (!raw) throw new Response("Scope not found", { status: 404 });

  const allScopeDetails = await listScopeDetails(dir);
  const allScopes = allScopeDetails.map((s) => ({ id: s.id, name: s.name }));
  const scopeById = new Map(allScopeDetails.map((s) => [s.id, s]));

  const meta = await readDocoMetadata(dir);
  const docoId = meta?.docoId ?? null;

  // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G all rule groups are
  // first-class Rule entities now. One query, then we bucket in code.
  type Row = {
    id: string;
    summary: string;
    lifecycle: string;
    raw_yaml: string;
    created_at: string | Date | null;
  };
  const ruleRows: Row[] = docoId
    ? await withClient(async (c) => {
        const r = await c.query<Row>(
          `SELECT r.id, r.summary, COALESCE(r.lifecycle, 'active') AS lifecycle, r.raw_yaml, r.created_at
             FROM rules r
             JOIN edges e ON e.from_id = r.id
                         AND e.edge_type = 'in_scope_of'
                         AND e.to_id = $1
            WHERE r.doco_id = $2
            ORDER BY (CASE WHEN COALESCE(r.lifecycle, 'active') IN ('active', 'proposed') THEN 0 ELSE 1 END),
                     r.created_at DESC`,
          [id, docoId],
        );
        return r.rows;
      })
    : [];
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): a Rule is "authoring"
  // for this scope iff the scope cites it via `gated_by`. Bucket
  // accordingly. The local "authoring" label is presentational — the
  // engine drove the semantics by reading gated_by upstream.
  const scopeGatedBy = new Set<string>(
    Array.isArray(raw.gated_by)
      ? raw.gated_by.filter((v: unknown): v is string => typeof v === "string")
      : [],
  );
  const rulesByKind: Record<RuleKind, RuleRecord[]> = {
    authoring: [],
    guidance: [],
    tagged: [],
  };
  for (const row of ruleRows) {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(row.raw_yaml) as Record<string, unknown>;
    } catch {}
    const predicate = fm.predicate as AuthoringPredicateRecord | undefined;
    let kind: RuleKind;
    if (scopeGatedBy.has(row.id) && predicate && typeof predicate === "object") {
      kind = "authoring";
    } else if (fm.kind === "guidance") {
      kind = "guidance";
    } else {
      kind = "tagged";
    }
    rulesByKind[kind].push({
      id: row.id,
      summary: row.summary,
      lifecycle: row.lifecycle,
      kind,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : typeof row.created_at === "string"
            ? row.created_at
            : null,
      ...(predicate && typeof predicate === "object" ? { predicate } : {}),
    });
  }

  // Stats: count entities tagged with this scope by lifecycle.
  const memberStats: { lifecycle: string; count: number; updatedAt: string | null }[] = docoId
    ? await withClient(async (c) => {
        const tables = [
          "decisions",
          "intents",
          "actions",
          "rules",
          "evals",
          "reference_entities",
          "ideas",
          "logs",
          // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): States count too.
          "states",
        ];
        const unionSql = tables
          .map(
            (t) =>
              `SELECT COALESCE(${t}.lifecycle, 'active') AS lifecycle, ${t}.updated_at FROM ${t}
                 JOIN edges e ON e.from_id = ${t}.id
                              AND e.edge_type = 'in_scope_of'
                              AND e.to_id = $1
                WHERE ${t}.doco_id = $2`,
          )
          .join(" UNION ALL ");
        const rs = await c.query<{
          lifecycle: string;
          n: string;
          updated_at: Date | string | null;
        }>(
          `SELECT lifecycle, COUNT(*)::text AS n, MAX(updated_at) AS updated_at FROM (${unionSql}) t
             GROUP BY lifecycle ORDER BY lifecycle`,
          [id, docoId],
        );
        return rs.rows.map((r) => ({
          lifecycle: r.lifecycle,
          count: Number(r.n),
          updatedAt: toIso(r.updated_at),
        }));
      })
    : [];
  const memberCount = memberStats.reduce((sum, s) => sum + s.count, 0);

  // Stats: count entities tagged with this scope by node type.
  const memberTypeStats: { nodeType: string; count: number; updatedAt: string | null }[] = docoId
    ? await withClient(async (c) => {
        const tables: { table: string; nodeType: string }[] = [
          { table: "decisions", nodeType: "decision" },
          { table: "intents", nodeType: "intent" },
          { table: "actions", nodeType: "action" },
          { table: "logs", nodeType: "log" },
          { table: "rules", nodeType: "rule" },
          { table: "evals", nodeType: "eval" },
          { table: "reference_entities", nodeType: "reference" },
          { table: "ideas", nodeType: "idea" },
          { table: "logs", nodeType: "log" },
          // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): State node type.
          { table: "states", nodeType: "state" },
        ];
        const unionSql = tables
          .map(
            (t) =>
              `SELECT '${t.nodeType}'::text AS node_type, ${t.table}.updated_at FROM ${t.table}
                 JOIN edges e ON e.from_id = ${t.table}.id
                              AND e.edge_type = 'in_scope_of'
                              AND e.to_id = $1
                WHERE ${t.table}.doco_id = $2`,
          )
          .join(" UNION ALL ");
        const rs = await c.query<{
          node_type: string;
          n: string;
          updated_at: Date | string | null;
        }>(
          `SELECT node_type, COUNT(*)::text AS n, MAX(updated_at) AS updated_at FROM (${unionSql}) t
             GROUP BY node_type ORDER BY COUNT(*) DESC`,
          [id, docoId],
        );
        return rs.rows.map((r) => ({
          nodeType: r.node_type,
          count: Number(r.n),
          updatedAt: toIso(r.updated_at),
        }));
      })
    : [];

  // Heatmap data.
  const since = new Date();
  since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
  const sinceIso = since.toISOString().slice(0, 10);
  const byDay: Record<string, number> = docoId
    ? await withClient(async (c) => {
        const tables = [
          "decisions",
          "intents",
          "actions",
          "logs",
          "rules",
          "evals",
          "ideas",
          "reference_entities",
          // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): include States.
          "states",
        ];
        const unionSql = tables
          .map(
            (t) =>
              `SELECT to_char(${t}.created_at, 'YYYY-MM-DD') AS day FROM ${t}
                 JOIN edges e ON e.from_id = ${t}.id
                              AND e.edge_type = 'in_scope_of'
                              AND e.to_id = $1
                WHERE ${t}.doco_id = $2`,
          )
          .join(" UNION ALL ");
        const rs = await c.query<{ day: string; n: string }>(
          `SELECT day, COUNT(*)::text AS n FROM (${unionSql}) t WHERE day >= $3
             GROUP BY day`,
          [id, docoId, sinceIso],
        );
        const out: Record<string, number> = {};
        for (const r of rs.rows) out[r.day] = Number(r.n);
        return out;
      })
    : {};

  // Top contributors to entities currently tagged with this scope —
  // ranked by total audit-event count desc, last-contributed-at tiebreak.
  const topContributors: TopContributor[] = docoId
    ? await withClient(async (c) => {
        const rs = await c.query<{
          principal_id: string;
          username: string;
          last_at: Date | string;
          event_count: string;
        }>(
          `SELECT ae.by_principal AS principal_id,
                  p.username,
                  MAX(ae.at) AS last_at,
                  COUNT(*)::text AS event_count
             FROM audit_events ae
             JOIN principals p ON p.id = ae.by_principal
             JOIN edges e ON e.from_id = ae.entity_id
                          AND e.edge_type = 'in_scope_of'
                          AND e.to_id = $2
                          AND e.doco_id = ae.doco_id
            WHERE ae.doco_id = $1 AND ae.by_principal IS NOT NULL
            GROUP BY ae.by_principal, p.username
            ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
            LIMIT $3`,
          [docoId, id, TOP_CONTRIBUTORS_LIMIT],
        );
        return rs.rows.map((r) => ({
          principalId: r.principal_id,
          username: r.username,
          lastAt:
            r.last_at instanceof Date
              ? r.last_at.toISOString()
              : new Date(String(r.last_at)).toISOString(),
          eventCount: Number(r.event_count),
        }));
      })
    : [];

  // Latest 30 audit events for entities currently tagged with this scope.
  interface FeedItem extends ActivityFeedLineItem {
    event_id: string;
    lifecycle: string;
  }
  const items: FeedItem[] = docoId
    ? await withClient(async (c) => {
        const tables: { table: string; nodeType: string }[] = [
          { table: "decisions", nodeType: "decision" },
          { table: "intents", nodeType: "intent" },
          { table: "actions", nodeType: "action" },
          { table: "logs", nodeType: "log" },
          { table: "rules", nodeType: "rule" },
          { table: "evals", nodeType: "eval" },
          { table: "states", nodeType: "state" },
          { table: "reference_entities", nodeType: "reference" },
          { table: "ideas", nodeType: "idea" },
        ];
        const unionSql = tables
          .map(
            (t) =>
              `SELECT ${t.table}.id, '${t.nodeType}'::text AS node_type, ${t.table}.summary,
                      COALESCE(${t.table}.lifecycle, 'active') AS lifecycle
                 FROM ${t.table}
                WHERE ${t.table}.doco_id = $2`,
          )
          .join(" UNION ALL ");
        const rs = await c.query<
          Omit<FeedItem, "at" | "before" | "after"> & {
            at: Date | string;
            before_json: Record<string, unknown> | null;
            after_json: Record<string, unknown> | null;
          }
        >(
          `WITH entity_rows AS (${unionSql})
           SELECT a.event_id,
                  a.entity_id AS id,
                  a.entity_type AS node_type,
                  COALESCE(er.summary, a.after_json->>'summary', a.before_json->>'summary') AS summary,
                  COALESCE(er.lifecycle, a.after_json->>'lifecycle', a.before_json->>'lifecycle', 'active') AS lifecycle,
                  a.at,
                  a.op,
                  a.before_json,
                  a.after_json
             FROM audit_events a
             JOIN edges e ON e.from_id = a.entity_id
                         AND e.edge_type = 'in_scope_of'
                         AND e.to_id = $1
                         AND e.doco_id = a.doco_id
             LEFT JOIN entity_rows er ON er.id = a.entity_id
            WHERE a.doco_id = $2
            ORDER BY a.at DESC
            LIMIT 30`,
          [id, docoId],
        );
        const rows = rs.rows;
        const entityIds = Array.from(new Set(rows.map((row) => row.id)));
        const scopeEdges =
          entityIds.length > 0
            ? (
                await c.query<{ from_id: string; to_id: string }>(
                  `SELECT from_id, to_id FROM edges
                    WHERE edge_type = 'in_scope_of'
                      AND doco_id = $1
                      AND from_id = ANY($2::text[])`,
                  [docoId, entityIds],
                )
              ).rows
            : [];
        const scopeIdsByItem = new Map<string, string[]>();
        for (const edge of scopeEdges) {
          const arr = scopeIdsByItem.get(edge.from_id) ?? [];
          arr.push(edge.to_id);
          scopeIdsByItem.set(edge.from_id, arr);
        }
        return rows.map((row) => ({
          event_id: row.event_id,
          id: row.id,
          node_type: row.node_type,
          summary: row.summary,
          lifecycle: row.lifecycle,
          at:
            row.at instanceof Date ? row.at.toISOString() : new Date(String(row.at)).toISOString(),
          op: row.op,
          before: row.before_json,
          after: row.after_json,
          scopes: (scopeIdsByItem.get(row.id) ?? [])
            .map((scopeId) => scopeById.get(scopeId))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .map((s) => (s.icon ? { name: s.name, icon: s.icon } : { name: s.name })),
        }));
      })
    : [];

  const isWatched =
    String(raw.name) === "#global" ||
    String(raw.name) === "global" ||
    (raw as { watched?: unknown }).watched === true;
  // Scope description text now lives on the Scope row's `summary` column
  // (decision_01KRYECEA32SRSQCKFXSDCBK67). Prefer the column; fall back to
  // the YAML mirror for rows that haven't been migrated yet by
  // applyScopeTemplateUpdatesToDoco.
  const scopeRow = docoId
    ? await withClient((c) =>
        c.query<{ summary: string | null }>(
          "SELECT summary FROM scopes WHERE id = $1 LIMIT 1",
          [id],
        ),
      )
    : null;
  const scopeColumnSummary = (scopeRow?.rows[0]?.summary ?? "").trim();
  const scopeYamlSummary =
    typeof raw.summary === "string" && raw.summary.trim() !== `Scope: ${String(raw.name)}`
      ? raw.summary
      : "";
  const scopeSummary = scopeColumnSummary || scopeYamlSummary;
  const scopeAllowedNodeTypes = Array.isArray(
    (raw as { allowed_node_types?: unknown }).allowed_node_types,
  )
    ? ((raw as { allowed_node_types: unknown[] }).allowed_node_types).filter(
        (v): v is string => typeof v === "string",
      )
    : [];

  return {
    ownerSlug,
    docoSlug,
    handle,
    me,
    host: await loadHostConfig(),
    scope: {
      id: String(raw.id),
      name: String(raw.name),
      summary: scopeSummary,
      icon: typeof raw.icon === "string" ? raw.icon : "",
      lifecycle: typeof raw.lifecycle === "string" ? raw.lifecycle : "active",
      is_watched: isWatched,
      allowed_node_types: scopeAllowedNodeTypes,
      // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): surface the scope's
      // gating + lifecycle data so the editor can render it.
      default_node_lifecycle:
        typeof raw.default_node_lifecycle === "string" ? raw.default_node_lifecycle : null,
      gated_by: Array.from(scopeGatedBy),
      excluded_rules: Array.isArray(raw.excluded_rules)
        ? (raw.excluded_rules as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
    },
    rules: rulesByKind,
    allScopes,
    memberCount,
    memberStats,
    memberTypeStats,
    byDay,
    items,
    topContributors,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  const { dir, meta } = await loadDocoForAdmin(request, handle);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scopeId = id as EntityId<"scope">;
  const back = `/${handle}/scopes/${id}`;

  try {
    if (intent === "set_watched") {
      const watchedRaw = String(form.get("watched") ?? "");
      if (watchedRaw !== "true" && watchedRaw !== "false") {
        return { error: "Pick watched or not watched — no default per ADR-137bis." };
      }
      const raw = await readScopeRaw(id);
      if (
        raw &&
        (raw.name === "#global" || raw.name === "global") &&
        watchedRaw === "false"
      ) {
        return {
          error:
            "The Global scope (your doco's constitution) is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
        };
      }
      await setScopeWatchedInDoco({
        docoDir: dir,
        targetScopeId: scopeId,
        watched: watchedRaw === "true",
      });
    } else if (intent === "save_icon") {
      const icon = String(form.get("icon") ?? "").trim();
      await updateScopeInDoco({ docoDir: dir, scopeId, icon: icon || null });
    } else if (intent === "save_summary") {
      const summary = String(form.get("summary") ?? "").trim();
      if (!summary) return { error: "Description is required." };
      await updateScopeInDoco({ docoDir: dir, scopeId, summary });
    } else if (intent === "abandon_rule" || intent === "activate_rule") {
      // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G abandoning any rule
      // (authoring, guidance, or tagged) is the same operation: PATCH the
      // Rule entity's lifecycle.
      const ruleId = String(form.get("rule_id") ?? "");
      if (!ruleId.startsWith("rule_")) {
        return { error: "rule_id missing or malformed." };
      }
      const nextLifecycle = intent === "abandon_rule" ? "abandoned" : "active";
      const result = await updateEntity({
        docoDir: dir,
        docoId: meta.docoId,
        ownerSlug,
        docoSlug,
        nodeType: "rule",
        pluralDir: "rules",
        id: ruleId,
        patch: { lifecycle: nextLifecycle },
        allowedFields: ["lifecycle"],
        docoHost: new URL(request.url).origin,
        actorId: null,
      });
      if ("error" in result) {
        return { error: (result as { error: string }).error };
      }
      await reindex(dir);
      return { ok: true, rule_id: ruleId, lifecycle: nextLifecycle };
    } else {
      return { error: `Unknown intent: ${intent}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(dir);
  if (intent === "set_watched") return { ok: true };
  return redirect(back);
}

export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const intent = String(formData?.get("intent") ?? "");
  if (intent === "abandon_rule" || intent === "activate_rule") {
    return false;
  }
  return defaultShouldRevalidate;
}

export function meta({ params }: { params: { docoId: string; id: string } }) {
  return [{ title: `${params.id} · ${params.docoId} · Doco` }];
}

function predicateShorthand(
  p: AuthoringPredicateRecord,
  allScopes: { id: string; name: string }[],
): string {
  const whenSuffix =
    Array.isArray(p.when_node_type) && p.when_node_type.length > 0
      ? ` (when ${p.when_node_type.join("/")})`
      : "";
  switch (p.kind) {
    case "requires_edge":
      return `requires \`${p.edge_type ?? "?"}\`${p.target_node_type ? ` → ${p.target_node_type}` : ""}${whenSuffix}`;
    case "forbids_edge":
      return `forbids \`${p.edge_type ?? "?"}\`${p.target_node_type ? ` → ${p.target_node_type}` : ""}${whenSuffix}`;
    case "requires_field":
      return `requires fields: ${asFieldList(p).join(", ") || "—"}${whenSuffix}`;
    case "forbids_field":
      return `forbids fields: ${asFieldList(p).join(", ") || "—"}${whenSuffix}`;
    case "mandatory_scope": {
      const names = asScopeIdList(p).map((id) => allScopes.find((s) => s.id === id)?.name ?? id);
      return `mandatory scope: ${names.join(", ") || "—"}`;
    }
    case "requires_node_type": {
      const types = Array.isArray(p.node_types) ? p.node_types : [];
      return `only allows: ${types.join(", ") || "—"}`;
    }
    case "probabilistic":
      return "LLM-judged at capture time";
    default:
      return p.kind;
  }
}

export default function ScopePage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const {
    ownerSlug,
    docoSlug,
    handle,
    scope,
    rules,
    allScopes,
    memberCount,
    memberStats,
    memberTypeStats,
    byDay,
    items,
    topContributors,
    me,
  } = loaderData;

  // Live revalidation for the activity feed.
  const revalidator = useRevalidator();
  useEffect(() => {
    let tick: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (tick !== null) return;
      tick = setInterval(() => {
        if (document.visibilityState === "visible" && revalidator.state === "idle") {
          revalidator.revalidate();
        }
      }, 5000);
    };
    const stop = () => {
      if (tick !== null) {
        clearInterval(tick);
        tick = null;
      }
    };
    start();
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revalidator]);

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <div className="flex items-baseline gap-3">
          <div className="flex min-w-0 items-baseline">
            <ScopeTitleIcon icon={scope.icon} />
            <h1 className="text-lg font-bold tracking-tight">
              <Link
                to={inScopeSearchPath(handle, scope.name, {})}
                className="font-mono hover:text-primary"
              >
                {scope.name}
              </Link>
              {scope.name === "#global" || scope.name === "global" ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {" "}
                  (your doco's constitution)
                </span>
              ) : null}
            </h1>
          </div>
          <Link
            to={`/${handle}/scopes`}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to scopes
          </Link>
        </div>

        <ScopeDescriptionCard scope={scope} />

        {(scope.default_node_lifecycle ||
          (scope.excluded_rules && scope.excluded_rules.length > 0)) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">v7 scope details</CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-2 text-muted-foreground">
              {scope.default_node_lifecycle ? (
                <p>
                  <span className="font-mono">default_node_lifecycle</span> ={" "}
                  <Badge>{scope.default_node_lifecycle}</Badge> — captures into this scope (or
                  descendants) start at this lifecycle unless the author passes an explicit
                  override.
                </p>
              ) : null}
              {scope.gated_by && scope.gated_by.length > 0 ? (
                <p>
                  <span className="font-mono">gated_by</span>: {scope.gated_by.length} rule
                  {scope.gated_by.length === 1 ? "" : "s"} cited as Doco-node-authoring rules for this scope
                  (see the Doco-node-authoring rules section below).
                </p>
              ) : null}
              {scope.excluded_rules && scope.excluded_rules.length > 0 ? (
                <p>
                  <span className="font-mono">excluded_rules</span>: {scope.excluded_rules.length}{" "}
                  inherited rule
                  {scope.excluded_rules.length === 1 ? "" : "s"} opted out —{" "}
                  {scope.excluded_rules.slice(0, 4).map((rid, i, arr) => (
                    <span key={rid}>
                      <Link to={entityUrl({ ownerSlug, docoSlug, nodeType: "rule", id: rid })}>
                        <span className="font-mono">{rid.slice(0, 18)}…</span>
                      </Link>
                      {i < arr.length - 1 ? ", " : ""}
                    </span>
                  ))}
                  {scope.excluded_rules.length > 4
                    ? `, +${scope.excluded_rules.length - 4} more`
                    : ""}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 min-[840px]:grid-cols-12">
          {/* Left column */}
          <div className="min-w-0 min-[840px]:col-span-6 space-y-4">
            <NodesOverviewCard
              sections={
                [
                  {
                    title: "Node types",
                    items: memberTypeStats.map((t) => ({
                      key: `type-${t.nodeType}`,
                      href: inScopeSearchPath(handle, scope.name, {
                        nodeType: t.nodeType,
                      }),
                      label: nodeTypeLabel(t.nodeType),
                      icon: <NodeTypeIcon nodeType={t.nodeType} />,
                      count: t.count,
                      ariaLabel: `View ${t.count} ${nodeTypeLabel(t.nodeType).toLowerCase()} in ${scope.name}`,
                      updatedAt: t.updatedAt,
                    })),
                  },
                  {
                    title: "Lifecycle",
                    items: memberStats.map((s) => ({
                      key: `lifecycle-${s.lifecycle}`,
                      href: inScopeSearchPath(handle, scope.name, {
                        lifecycle: s.lifecycle,
                      }),
                      label: s.lifecycle,
                      count: s.count,
                      ariaLabel: `View ${s.count} ${s.lifecycle} nodes in ${scope.name}`,
                      color: lifecycleColor(s.lifecycle),
                      updatedAt: s.updatedAt,
                    })),
                  },
                ] satisfies NodesOverviewSection[]
              }
              empty={
                <p className="text-xs italic text-muted-foreground">
                  No nodes are tagged with this scope yet.
                </p>
              }
              aside={<TopContributorsList contributors={topContributors} />}
              search={
                <Form
                  method="get"
                  action={`/${handle}/search`}
                  className="flex flex-col gap-2 sm:flex-row"
                >
                  <input type="hidden" name="scope" value={scope.name} />
                  <input type="hidden" name="lifecycle" value="*" />
                  <input type="hidden" name="node_type" value="*" />
                  <input type="hidden" name="limit" value="500" />
                  <label className="sr-only" htmlFor="scope-node-search">
                    Search nodes in {scope.name}
                  </label>
                  <input
                    id="scope-node-search"
                    name="q"
                    placeholder={
                      memberCount > 0
                        ? `Search ${memberCount} node${memberCount === 1 ? "" : "s"} in this scope…`
                        : "Search nodes in this scope…"
                    }
                    className="min-w-0 flex-1 rounded-md border border-border bg-input px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted"
                  >
                    Search
                  </button>
                </Form>
              }
            />

            {/* Watched toggle */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Watched?</CardTitle>
                <CardDescription>
                  A <strong>watched</strong> scope nudges contributors to consider it when capturing
                  work. The Global scope (your doco's constitution) is always watched and cannot be
                  unwatched.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <WatchedSwitch
                  isWatched={scope.is_watched}
                  scopeName={scope.name}
                  locked={scope.name === "#global" || scope.name === "global"}
                />
              </CardContent>
            </Card>

            <RuleSectionCard
              title="Guidance rules"
              description={
                "Prose contributors read while working in or with this scope. No automated check — directive but not enforced."
              }
              kind="guidance"
              rules={rules.guidance}
              allScopes={allScopes}
              ownerSlug={ownerSlug}
              docoSlug={docoSlug}
              handle={handle}
              scopeId={scope.id}
            />

            <RuleSectionCard
              title="Doco-node-authoring rules"
              description={
                "Predicates the engine evaluates whenever a Doco node is captured into this scope (NOT rules about how the project owner authors code or commits — those are guidance rules). Deterministic kinds block writes structurally; probabilistic specs are judged at capture time."
              }
              kind="authoring"
              rules={rules.authoring}
              allScopes={allScopes}
              ownerSlug={ownerSlug}
              docoSlug={docoSlug}
              handle={handle}
              scopeId={scope.id}
            />

            {scope.name === "#global" || scope.name === "global" ? null : (
              <Card className="border-destructive/40">
                <CardHeader>
                  <CardTitle className="text-sm text-destructive">Abandon scope</CardTitle>
                  <CardDescription>
                    Abandon this scope. Existing members keep their tag and remain queryable, but
                    new captures referencing this scope are rejected.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Link
                    to={`/${handle}/scopes/${scope.id}/abandon`}
                    className="inline-flex items-center rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
                  >
                    Abandon scope →
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right column — activity heatmap + feed */}
          <aside className="min-w-0 min-[840px]:col-span-6 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Activity</CardTitle>
                <CardDescription>
                  Captures tagged with this scope over the last year.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Latest activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 ? (
                  <div className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
                    No scoped activity yet.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {items.map((it) => (
                      <ActivityFeedLine
                        key={it.event_id}
                        item={it}
                        ownerSlug={ownerSlug}
                        docoSlug={docoSlug}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}

function ScopeDescriptionCard({
  scope,
}: {
  scope: {
    id: string;
    name: string;
    summary: string;
  };
}) {
  // Per decision_01KRYECEA32SRSQCKFXSDCBK67 the scope's description text
  // lives on Scope.summary directly — no Intent indirection. The
  // rules-only constraint stays enforced server-side; the UI no longer
  // narrates it — the friendlier Scope.summary copy carries the message.
  const fetcher = useFetcher<{ error?: string }>();
  const [editing, setEditing] = useState(false);
  const isSaving = fetcher.state !== "idle";
  // Close edit mode once a successful save round-trips. fetcher.data is
  // populated with the action's return value after the form submits.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !fetcher.data.error) {
      setEditing(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardHeader>
        {editing ? (
          <fetcher.Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="save_summary" />
            <textarea
              name="summary"
              defaultValue={scope.summary}
              rows={3}
              required
              autoFocus
              placeholder="What this scope is meant to make true."
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
            />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={isSaving}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={isSaving}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              {fetcher.data?.error ? (
                <span className="text-[11px] text-destructive">{fetcher.data.error}</span>
              ) : null}
            </div>
          </fetcher.Form>
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {scope.summary ? (
                <CardDescription className="text-xs leading-relaxed">
                  {scope.summary}
                </CardDescription>
              ) : (
                <CardDescription className="text-xs italic">
                  No description yet. Click the pencil to add one.
                </CardDescription>
              )}
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit description"
              title="Edit description"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        )}
      </CardHeader>
    </Card>
  );
}

function TopContributorsList({ contributors }: { contributors: TopContributor[] }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs font-semibold text-foreground">Top contributors</h2>
      {contributors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No recorded contributions yet.</p>
      ) : (
        contributors.map((c) => (
          <div
            key={c.principalId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
          >
            <span className="truncate text-xs" title={c.username}>
              {c.username}
            </span>
            <time
              dateTime={c.lastAt}
              title={c.lastAt}
              suppressHydrationWarning
              className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
            >
              {timeAgo(c.lastAt)}
            </time>
          </div>
        ))
      )}
    </section>
  );
}

function ScopeTitleIcon({ icon }: { icon: string }) {
  const fetcher = useFetcher<{ error?: string }>();
  const isSaving = fetcher.state !== "idle";

  function saveIcon(nextIcon: string) {
    if (!nextIcon || nextIcon === icon) return;
    const formData = new FormData();
    formData.set("intent", "save_icon");
    formData.set("icon", nextIcon);
    fetcher.submit(formData, { method: "post" });
  }

  return (
    <span className="relative mr-1 inline-flex align-baseline">
      <EmojiPickerInput
        name="icon"
        defaultValue={icon}
        placeholder="📔"
        showClearButton={false}
        triggerAriaLabel="Change scope icon"
        triggerWidthClass="w-auto"
        triggerExtraClass="inline-flex h-[1.2em] min-w-[1.2em] items-center justify-center rounded-sm border-0 bg-transparent p-0 text-lg leading-none hover:bg-muted focus:border-transparent focus:bg-muted"
        onValueChange={saveIcon}
      />
      {isSaving ? <span className="sr-only">Saving scope icon</span> : null}
      {fetcher.data?.error ? (
        <span className="absolute left-0 top-full mt-1 whitespace-nowrap text-[10px] font-normal text-destructive">
          {fetcher.data.error}
        </span>
      ) : null}
    </span>
  );
}

function RuleSectionCard({
  title,
  description,
  kind,
  rules,
  allScopes,
  ownerSlug,
  docoSlug,
  handle,
  scopeId,
}: {
  title: string;
  description: string;
  kind: RuleKind;
  rules: RuleRecord[];
  allScopes: { id: string; name: string }[];
  ownerSlug: string;
  docoSlug: string;
  handle: string;
  scopeId: string;
}) {
  const [localRules, setLocalRules] = useState(rules);

  useEffect(() => {
    setLocalRules(rules);
  }, [rules]);

  const updateRuleLifecycle = (ruleId: string, lifecycle: string) => {
    setLocalRules((current) => current.map((r) => (r.id === ruleId ? { ...r, lifecycle } : r)));
  };

  const active = localRules.filter((r) => isActive(r.lifecycle));
  const abandoned = localRules.filter((r) => !isActive(r.lifecycle));
  const badgeFor = (r: RuleRecord) => {
    if (kind === "authoring" && r.predicate) {
      return `Authoring · ${r.predicate.kind === "probabilistic" ? "probabilistic" : "deterministic"}`;
    }
    if (kind === "guidance") return "Guidance";
    return "Rule";
  };
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm">
              {title} ({active.length}
              {abandoned.length > 0 ? ` + ${abandoned.length} abandoned` : ""})
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Link
            to={`/${handle}/scopes/${scopeId}/rules/new?kind=${kind}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-card"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {kind === "guidance" ? "Add guidance" : "Add authoring"}
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {active.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">No active rules.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((r) => (
              <li
                key={r.id}
                className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
              >
                <Badge>{badgeFor(r)}</Badge>
                <div className="flex-1 space-y-0.5">
                  <Link
                    to={entityUrl({ ownerSlug, docoSlug, nodeType: "rule", id: r.id })}
                    className="block text-foreground hover:text-primary"
                  >
                    {r.summary}
                  </Link>
                  <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                    <span>Added {timeAgo(r.createdAt)}</span>
                    {r.predicate ? (
                      <span className="font-mono">
                        {predicateShorthand(r.predicate, allScopes)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <RuleLifecycleButton
                  rule={r}
                  intent="abandon_rule"
                  nextLifecycle="abandoned"
                  label="Abandon"
                  className="text-destructive hover:bg-destructive/10"
                  onLifecycleChange={updateRuleLifecycle}
                />
              </li>
            ))}
          </ul>
        )}
        {abandoned.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Show abandoned ({abandoned.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {abandoned.map((r) => (
                <li
                  key={r.id}
                  className="flex items-baseline gap-2 rounded-md border border-border bg-card/50 p-2 text-xs opacity-60"
                >
                  <Badge>{r.lifecycle}</Badge>
                  <div className="flex-1 space-y-0.5">
                    <Link
                      to={entityUrl({ ownerSlug, docoSlug, nodeType: "rule", id: r.id })}
                      className="block text-foreground line-through hover:text-primary"
                    >
                      {r.summary}
                    </Link>
                    <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                      <span>Added {timeAgo(r.createdAt)}</span>
                      {r.predicate ? (
                        <span className="font-mono">
                          {predicateShorthand(r.predicate, allScopes)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <RuleLifecycleButton
                    rule={r}
                    intent="activate_rule"
                    nextLifecycle="active"
                    label="Activate"
                    className="text-foreground hover:bg-card"
                    onLifecycleChange={updateRuleLifecycle}
                  />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RuleLifecycleButton({
  rule,
  intent,
  nextLifecycle,
  label,
  className,
  onLifecycleChange,
}: {
  rule: RuleRecord;
  intent: "abandon_rule" | "activate_rule";
  nextLifecycle: string;
  label: string;
  className: string;
  onLifecycleChange: (ruleId: string, lifecycle: string) => void;
}) {
  const fetcher = useFetcher<RuleLifecycleActionResult>();
  const isSubmitting = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok === true &&
      fetcher.data.rule_id === rule.id &&
      fetcher.data.lifecycle
    ) {
      onLifecycleChange(rule.id, fetcher.data.lifecycle);
    }
  }, [fetcher.state, fetcher.data, onLifecycleChange, rule.id]);

  return (
    <fetcher.Form method="post" className="flex shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="rule_id" value={rule.id} />
      <button
        type="submit"
        disabled={isSubmitting}
        className={`rounded-md border border-border px-2 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
        aria-label={`${label} rule ${rule.id}`}
      >
        {isSubmitting ? "Saving..." : label}
      </button>
      {error ? (
        <span className="max-w-32 text-right text-[10px] text-destructive">{error}</span>
      ) : null}
    </fetcher.Form>
  );
}

/**
 * Watched-flag toggle — auto-saves on change. Locked + always-on for the
 * Global scope (your doco's constitution).
 */
function WatchedSwitch({
  isWatched,
  scopeName,
  locked = false,
}: {
  isWatched: boolean;
  scopeName: string;
  locked?: boolean;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const submitted = fetcher.formData?.get("watched");
  const checked = locked
    ? true
    : submitted === "true" || submitted === "false"
      ? submitted === "true"
      : isWatched;
  const error = fetcher.data?.error;
  if (locked) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Toggle
          checked={true}
          disabled
          label={`${scopeName} is always watched`}
          onCheckedChange={() => {
            /* no-op */
          }}
        />
        <span className="text-foreground">
          Always watched — the Global scope (your doco's constitution) is a framework invariant.
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <Toggle
        checked={checked}
        label={checked ? `Stop watching ${scopeName}` : `Watch ${scopeName}`}
        onCheckedChange={(next) => {
          fetcher.submit({ intent: "set_watched", watched: String(next) }, { method: "post" });
        }}
      />
      <span className="text-foreground">
        {checked
          ? "Watched — contributors should look for opportunities to document here."
          : "Not watched."}
      </span>
      {fetcher.state !== "idle" ? (
        <span className="text-[11px] text-muted-foreground">Saving…</span>
      ) : null}
      {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
    </div>
  );
}
