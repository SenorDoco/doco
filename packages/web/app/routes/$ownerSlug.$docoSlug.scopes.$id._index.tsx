// /<owner>/<doco>/scopes/<id> — merged scope detail + edit page.
//
// Per decision_01KRPNZY7W6CCMYNKGND67BP0B the separate detail (/scope/<id>)
// and edit (/scopes/<id>/edit) pages collapsed into this one. Layout: two
// columns. The left column carries everything editable about the scope
// (icon, watched flag, the three rule lists, a link to the standalone
// /deprecate page); the right column carries the activity heatmap and the
// latest-activity feed filtered to entities tagged with this scope.
//
// Rules now follow per-rule lifecycle (active / abandoned / superseded /
// proposed). "Deprecate" sets `abandoned`; "Reactivate" sets `active`.
// The engine + the agent-facing surfaces only consider non-abandoned
// rules. Tagged rules are first-class Rule entities (with their own
// lifecycle on the Rule node) listed here for context — deprecating a
// tagged rule PATCHes the Rule entity, not the scope.
import { useEffect, useState } from "react";
import { Form, Link, redirect, useFetcher, useRevalidator } from "react-router";
import { parse as parseYaml } from "yaml";
import type { EntityId } from "@doco/shared";
import { entityUrl } from "@doco/shared";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { EmojiPickerInput } from "~/components/emoji-picker-input";
import { SiteHeader } from "~/components/site-header";
import { Toggle } from "~/components/toggle";
import { withClient } from "@doco/db";
import { loadDocoForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import {
  classifyRuleProse,
  LlmUnavailableError,
  type ClassifiedRule,
} from "~/lib/llm.server";
import { reindex, setScopeWatchedInDoco, updateScopeInDoco } from "~/lib/redeem.server";
import { updateEntity } from "~/lib/capture.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";

const HEATMAP_WEEKS = 26;

interface AuthoringRuleRecord {
  kind: string;
  edge_type?: string;
  target_node_type?: string;
  field?: string;
  fields?: string[];
  scope_id?: string;
  scope_ids?: string[];
  spec?: string;
  reason?: string;
  lifecycle?: string;
}

interface GuidanceRuleRecord {
  text: string;
  lifecycle?: string;
}

interface TaggedRuleRecord {
  id: string;
  summary: string;
  lifecycle: string;
}

function asFieldList(r: AuthoringRuleRecord): string[] {
  if (Array.isArray(r.fields)) return r.fields.filter((f): f is string => typeof f === "string");
  if (typeof r.field === "string" && r.field.length > 0) return [r.field];
  return [];
}

function asScopeIdList(r: AuthoringRuleRecord): string[] {
  if (Array.isArray(r.scope_ids))
    return r.scope_ids.filter((s): s is string => typeof s === "string");
  if (typeof r.scope_id === "string" && r.scope_id.length > 0) return [r.scope_id];
  return [];
}

function ruleLifecycle(rule: { lifecycle?: string } | { lifecycle?: string; text: string }): string {
  return (rule as { lifecycle?: string }).lifecycle ?? "active";
}

function isActive(lifecycle: string): boolean {
  return lifecycle === "active" || lifecycle === "proposed";
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
  params: { ownerSlug: string; docoSlug: string; id: string };
}) {
  const { ownerSlug, docoSlug, id } = params;
  const { dir, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const raw = await readScopeRaw(id);
  if (!raw) throw new Response("Scope not found", { status: 404 });

  const allScopeDetails = await listScopeDetails(dir);
  const allScopes = allScopeDetails.map((s) => ({ id: s.id, name: s.name }));

  const authoringRules: AuthoringRuleRecord[] = Array.isArray(raw.authoring_rules)
    ? (raw.authoring_rules as AuthoringRuleRecord[])
    : [];
  const guidanceRules: GuidanceRuleRecord[] = Array.isArray(raw.guidance_rules)
    ? (raw.guidance_rules as unknown[])
        .map((g): GuidanceRuleRecord | null => {
          if (typeof g === "string") return { text: g, lifecycle: "active" };
          if (g && typeof g === "object" && typeof (g as { text?: unknown }).text === "string") {
            const obj = g as GuidanceRuleRecord;
            return { text: obj.text, ...(obj.lifecycle ? { lifecycle: obj.lifecycle } : {}) };
          }
          return null;
        })
        .filter((g): g is GuidanceRuleRecord => g !== null)
    : [];

  const meta = await readDocoMetadata(dir);
  const docoId = meta?.docoId ?? null;

  // Tagged Rule entities (first-class Rule nodes with an
  // in_scope_of edge pointing here). Includes lifecycle so the UI can
  // surface deprecate/reactivate.
  const taggedRules: TaggedRuleRecord[] = docoId
    ? await withClient(async (c) => {
        const rs = await c.query<TaggedRuleRecord>(
          `SELECT r.id, r.summary, COALESCE(r.lifecycle, 'active') AS lifecycle
             FROM rules r
             JOIN edges e ON e.from_id = r.id
                         AND e.edge_type = 'in_scope_of'
                         AND e.to_id = $1
            WHERE r.doco_id = $2
            ORDER BY (CASE WHEN COALESCE(r.lifecycle, 'active') = 'active' THEN 0 ELSE 1 END),
                     r.created_at DESC`,
          [id, docoId],
        );
        return rs.rows;
      })
    : [];

  // Stats: count entities tagged with this scope, grouped by lifecycle.
  // We join across entity tables via the `in_scope_of` edge.
  const memberStats: { lifecycle: string; count: number }[] = docoId
    ? await withClient(async (c) => {
        const tables = [
          "decisions",
          "intents",
          "actions",
          "rules",
          "reasoning",
          "evals",
          "reference_entities",
          "ideas",
        ];
        const unionSql = tables
          .map(
            (t) =>
              `SELECT COALESCE(${t}.lifecycle, 'active') AS lifecycle FROM ${t}
                 JOIN edges e ON e.from_id = ${t}.id
                              AND e.edge_type = 'in_scope_of'
                              AND e.to_id = $1
                WHERE ${t}.doco_id = $2`,
          )
          .join(" UNION ALL ");
        const rs = await c.query<{ lifecycle: string; n: string }>(
          `SELECT lifecycle, COUNT(*)::text AS n FROM (${unionSql}) t
             GROUP BY lifecycle ORDER BY lifecycle`,
          [id, docoId],
        );
        return rs.rows.map((r) => ({ lifecycle: r.lifecycle, count: Number(r.n) }));
      })
    : [];
  const memberCount = memberStats.reduce((sum, s) => sum + s.count, 0);

  // Heatmap data: per-day created_at counts for entities tagged with
  // this scope over the last HEATMAP_WEEKS.
  const since = new Date();
  since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
  const sinceIso = since.toISOString().slice(0, 10);
  const byDay: Record<string, number> = docoId
    ? await withClient(async (c) => {
        const rs = await c.query<{ day: string; n: string }>(
          `SELECT day, COUNT(*)::text AS n FROM (
             SELECT to_char(decisions.created_at, 'YYYY-MM-DD') AS day FROM decisions
               JOIN edges e ON e.from_id = decisions.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE decisions.doco_id = $2
             UNION ALL SELECT to_char(intents.created_at, 'YYYY-MM-DD') FROM intents
               JOIN edges e ON e.from_id = intents.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE intents.doco_id = $2
             UNION ALL SELECT to_char(actions.created_at, 'YYYY-MM-DD') FROM actions
               JOIN edges e ON e.from_id = actions.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE actions.doco_id = $2
             UNION ALL SELECT to_char(rules.created_at, 'YYYY-MM-DD') FROM rules
               JOIN edges e ON e.from_id = rules.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE rules.doco_id = $2
             UNION ALL SELECT to_char(reasoning.created_at, 'YYYY-MM-DD') FROM reasoning
               JOIN edges e ON e.from_id = reasoning.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE reasoning.doco_id = $2
             UNION ALL SELECT to_char(evals.created_at, 'YYYY-MM-DD') FROM evals
               JOIN edges e ON e.from_id = evals.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE evals.doco_id = $2
             UNION ALL SELECT to_char(ideas.created_at, 'YYYY-MM-DD') FROM ideas
               JOIN edges e ON e.from_id = ideas.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE ideas.doco_id = $2
             UNION ALL SELECT to_char(reference_entities.created_at, 'YYYY-MM-DD') FROM reference_entities
               JOIN edges e ON e.from_id = reference_entities.id AND e.edge_type = 'in_scope_of' AND e.to_id = $1
              WHERE reference_entities.doco_id = $2
           ) t WHERE day >= $3
           GROUP BY day`,
          [id, docoId, sinceIso],
        );
        const out: Record<string, number> = {};
        for (const r of rs.rows) out[r.day] = Number(r.n);
        return out;
      })
    : {};

  // Latest 30 entities tagged with this scope, for the feed.
  type FeedItem = { id: string; node_type: string; summary: string; lifecycle: string; created_at: string };
  const items: FeedItem[] = docoId
    ? await withClient(async (c) => {
        const tables: { table: string; nodeType: string }[] = [
          { table: "decisions", nodeType: "decision" },
          { table: "intents", nodeType: "intent" },
          { table: "actions", nodeType: "action" },
          { table: "rules", nodeType: "rule" },
          { table: "reasoning", nodeType: "reasoning" },
          { table: "evals", nodeType: "eval" },
          { table: "reference_entities", nodeType: "reference" },
          { table: "ideas", nodeType: "idea" },
        ];
        const unionSql = tables
          .map(
            (t) =>
              `SELECT ${t.table}.id, '${t.nodeType}'::text AS node_type, ${t.table}.summary,
                      COALESCE(${t.table}.lifecycle, 'active') AS lifecycle, ${t.table}.created_at
                 FROM ${t.table}
                 JOIN edges e ON e.from_id = ${t.table}.id
                              AND e.edge_type = 'in_scope_of'
                              AND e.to_id = $1
                WHERE ${t.table}.doco_id = $2`,
          )
          .join(" UNION ALL ");
        const rs = await c.query<FeedItem>(
          `SELECT * FROM (${unionSql}) t ORDER BY created_at DESC LIMIT 30`,
          [id, docoId],
        );
        return rs.rows;
      })
    : [];

  const isWatched =
    String(raw.name) === "global" || (raw as { watched?: unknown }).watched === true;

  return {
    ownerSlug,
    docoSlug,
    me,
    host: await loadHostConfig(),
    scope: {
      id: String(raw.id),
      name: String(raw.name),
      icon: typeof raw.icon === "string" ? raw.icon : "",
      lifecycle: typeof raw.lifecycle === "string" ? raw.lifecycle : "active",
      authoring_rules: authoringRules,
      guidance_rules: guidanceRules,
      is_watched: isWatched,
    },
    allScopes,
    memberCount,
    memberStats,
    byDay,
    items,
    taggedRules,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string; id: string };
}) {
  const { ownerSlug, docoSlug, id } = params;
  const { dir, meta } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scopeId = id as EntityId<"scope">;
  const back = `/${ownerSlug}/${docoSlug}/scopes/${id}`;

  try {
    if (intent === "set_watched") {
      const watchedRaw = String(form.get("watched") ?? "");
      if (watchedRaw !== "true" && watchedRaw !== "false") {
        return { error: "Pick watched or not watched — no default per ADR-137bis." };
      }
      const raw = await readScopeRaw(id);
      if (raw && raw.name === "global" && watchedRaw === "false") {
        return {
          error:
            "The Global scope (the doco's constitution) is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
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
    } else if (intent === "classify_rule_prose") {
      const prose = String(form.get("prose") ?? "").trim();
      if (!prose) return { error: "Type the rule in your own words." };
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const allScopeDetails = await listScopeDetails(dir);
      try {
        const classified = await classifyRuleProse({
          prose,
          scopeName: String(raw.name),
          availableScopes: allScopeDetails.map((s) => ({ id: s.id, name: s.name })),
        });
        return { classified, originalProse: prose };
      } catch (e) {
        if (e instanceof LlmUnavailableError) {
          return {
            error: `Classifier unavailable — ${e.message} The host must reach OpenAI to author rules from prose.`,
          };
        }
        return { error: (e as Error).message };
      }
    } else if (intent === "add_rules_classified") {
      const payload = String(form.get("payload") ?? "");
      if (!payload) return { error: "No classified payload to add." };
      let parsed: ClassifiedRule[];
      try {
        parsed = JSON.parse(payload) as ClassifiedRule[];
      } catch (e) {
        return { error: `Invalid classified payload: ${(e as Error).message}` };
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { error: "No rules to add." };
      }
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const existingAuthoring: AuthoringRuleRecord[] = Array.isArray(raw.authoring_rules)
        ? (raw.authoring_rules as AuthoringRuleRecord[])
        : [];
      const existingGuidance: GuidanceRuleRecord[] = Array.isArray(raw.guidance_rules)
        ? ((raw.guidance_rules as unknown[])
            .map((g): GuidanceRuleRecord | null => {
              if (typeof g === "string") return { text: g, lifecycle: "active" };
              if (g && typeof g === "object" && typeof (g as { text?: unknown }).text === "string") {
                const obj = g as GuidanceRuleRecord;
                return { text: obj.text, ...(obj.lifecycle ? { lifecycle: obj.lifecycle } : { lifecycle: "active" }) };
              }
              return null;
            })
            .filter((g): g is GuidanceRuleRecord => g !== null))
        : [];
      const newAuthoring: AuthoringRuleRecord[] = [];
      const newGuidance: GuidanceRuleRecord[] = [];
      for (const c of parsed) {
        if (c.bucket === "guidance") {
          if (c.text.trim()) newGuidance.push({ text: c.text.trim(), lifecycle: "active" });
          continue;
        }
        const base: AuthoringRuleRecord = {
          ...(c.rule as unknown as AuthoringRuleRecord),
          lifecycle: "active",
        };
        if (c.rule.kind !== "probabilistic" && !base.reason && c.text.trim()) {
          base.reason = c.text.trim();
        }
        newAuthoring.push(base);
      }
      const nextAuthoring = [...existingAuthoring, ...newAuthoring];
      const nextGuidance = [...existingGuidance, ...newGuidance];
      await updateScopeInDoco({
        docoDir: dir,
        scopeId,
        ...(newAuthoring.length > 0 ? { authoring_rules: nextAuthoring } : {}),
        ...(newGuidance.length > 0 ? { guidance_rules: nextGuidance } : {}),
      });
      await reindex(dir);
      return {
        ok: true,
        added_authoring: newAuthoring.length,
        added_guidance: newGuidance.length,
      };
    } else if (
      intent === "deprecate_authoring_rule" ||
      intent === "reactivate_authoring_rule"
    ) {
      const indexStr = String(form.get("rule_index") ?? "");
      const idx = Number.parseInt(indexStr, 10);
      if (!Number.isInteger(idx) || idx < 0) return { error: "Invalid rule index." };
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const existing: AuthoringRuleRecord[] = Array.isArray(raw.authoring_rules)
        ? (raw.authoring_rules as AuthoringRuleRecord[])
        : [];
      if (idx >= existing.length) return { error: "Rule index out of range." };
      const nextLifecycle =
        intent === "deprecate_authoring_rule" ? "abandoned" : "active";
      const next = existing.map((r, i) => (i === idx ? { ...r, lifecycle: nextLifecycle } : r));
      await updateScopeInDoco({ docoDir: dir, scopeId, authoring_rules: next });
    } else if (
      intent === "deprecate_guidance_rule" ||
      intent === "reactivate_guidance_rule"
    ) {
      const indexStr = String(form.get("rule_index") ?? "");
      const idx = Number.parseInt(indexStr, 10);
      if (!Number.isInteger(idx) || idx < 0) return { error: "Invalid rule index." };
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const existingRaw: unknown[] = Array.isArray(raw.guidance_rules)
        ? (raw.guidance_rules as unknown[])
        : [];
      const existing: GuidanceRuleRecord[] = existingRaw
        .map((g): GuidanceRuleRecord | null => {
          if (typeof g === "string") return { text: g, lifecycle: "active" };
          if (g && typeof g === "object" && typeof (g as { text?: unknown }).text === "string") {
            const obj = g as GuidanceRuleRecord;
            return { text: obj.text, lifecycle: obj.lifecycle ?? "active" };
          }
          return null;
        })
        .filter((g): g is GuidanceRuleRecord => g !== null);
      if (idx >= existing.length) return { error: "Rule index out of range." };
      const nextLifecycle =
        intent === "deprecate_guidance_rule" ? "abandoned" : "active";
      const next = existing.map((r, i) => (i === idx ? { ...r, lifecycle: nextLifecycle } : r));
      await updateScopeInDoco({ docoDir: dir, scopeId, guidance_rules: next });
    } else if (
      intent === "deprecate_tagged_rule" ||
      intent === "reactivate_tagged_rule"
    ) {
      // Tagged rules are first-class Rule entities — PATCH the Rule's own
      // lifecycle, not the scope's rule arrays.
      const ruleId = String(form.get("rule_id") ?? "");
      if (!ruleId.startsWith("rule_")) {
        return { error: "rule_id missing or malformed." };
      }
      const nextLifecycle =
        intent === "deprecate_tagged_rule" ? "abandoned" : "active";
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

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string; id: string } }) {
  return [{ title: `${params.id} · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

function describeAuthoringRule(
  r: AuthoringRuleRecord,
  allScopes: { id: string; name: string }[],
): string {
  if (r.reason) return r.reason;
  switch (r.kind) {
    case "requires_edge":
      return `Nodes must have an outgoing \`${r.edge_type}\` edge${r.target_node_type ? ` to a ${r.target_node_type}` : ""}.`;
    case "forbids_edge":
      return `Nodes must NOT have a \`${r.edge_type}\` edge${r.target_node_type ? ` to a ${r.target_node_type}` : ""}.`;
    case "requires_field": {
      const fields = asFieldList(r);
      if (fields.length === 0) return `Nodes must declare a field.`;
      if (fields.length === 1) return `Nodes must declare the \`${fields[0]}\` field.`;
      return `Nodes must declare these fields: ${fields.map((f) => `\`${f}\``).join(", ")}.`;
    }
    case "forbids_field": {
      const fields = asFieldList(r);
      if (fields.length === 0) return `Nodes must NOT declare a field.`;
      return `Nodes must NOT declare these fields: ${fields.map((f) => `\`${f}\``).join(", ")}.`;
    }
    case "mandatory_scope": {
      const ids = asScopeIdList(r);
      const names = ids.map((id) => allScopes.find((s) => s.id === id)?.name ?? id);
      if (names.length === 0) return `Every node in this Doco must list a scope.`;
      if (names.length === 1)
        return `Every node in this Doco must list scope \`${names[0]}\`.`;
      return `Every node in this Doco must list these scopes: ${names
        .map((n) => `\`${n}\``)
        .join(", ")}.`;
    }
    case "probabilistic":
      return `LLM-judged: ${r.spec}`;
    default:
      return `(${r.kind})`;
  }
}

function predicateShorthand(
  r: AuthoringRuleRecord,
  allScopes: { id: string; name: string }[],
): string {
  switch (r.kind) {
    case "requires_edge":
      return `requires \`${r.edge_type ?? "?"}\`${r.target_node_type ? ` → ${r.target_node_type}` : ""}`;
    case "forbids_edge":
      return `forbids \`${r.edge_type ?? "?"}\`${r.target_node_type ? ` → ${r.target_node_type}` : ""}`;
    case "requires_field":
      return `requires fields: ${asFieldList(r).join(", ") || "—"}`;
    case "forbids_field":
      return `forbids fields: ${asFieldList(r).join(", ") || "—"}`;
    case "mandatory_scope": {
      const names = asScopeIdList(r).map((id) => allScopes.find((s) => s.id === id)?.name ?? id);
      return `mandatory scope: ${names.join(", ") || "—"}`;
    }
    case "probabilistic":
      return "LLM-judged at capture time";
    default:
      return r.kind;
  }
}

export default function ScopePage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, scope, allScopes, memberCount, memberStats, byDay, items, taggedRules, me } =
    loaderData;

  // Live revalidation for the activity feed and rule counts — same
  // pattern as the Doco home page (ADR-089).
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

  const activeAuthoring = scope.authoring_rules.filter((r) => isActive(ruleLifecycle(r)));
  const deprecatedAuthoring = scope.authoring_rules.filter((r) => !isActive(ruleLifecycle(r)));
  const activeGuidance = scope.guidance_rules.filter((r) => isActive(ruleLifecycle(r)));
  const deprecatedGuidance = scope.guidance_rules.filter((r) => !isActive(ruleLifecycle(r)));
  const activeTagged = taggedRules.filter((r) => isActive(r.lifecycle));
  const deprecatedTagged = taggedRules.filter((r) => !isActive(r.lifecycle));

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-bold tracking-tight">
            {scope.icon ? <span className="mr-1">{scope.icon}</span> : null}
            <span className="font-mono">{scope.name}</span>
            {scope.name === "global" ? (
              <span className="ml-2 text-xs text-muted-foreground">(the doco's constitution)</span>
            ) : null}
          </h1>
          <Link
            to={`/${ownerSlug}/${docoSlug}/scopes`}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to scopes
          </Link>
        </div>

        <div className="grid gap-4 min-[840px]:grid-cols-12">
          {/* Left column */}
          <div className="min-[840px]:col-span-7 space-y-4">
            {/* Stats card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Members ({memberCount})</CardTitle>
                <CardDescription>
                  Nodes tagged with this scope, broken down by lifecycle.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {memberStats.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">
                    No nodes are tagged with this scope yet.
                  </p>
                ) : (
                  <dl className="grid grid-cols-2 gap-y-1 text-xs sm:grid-cols-3">
                    {memberStats.map((s) => (
                      <div key={s.lifecycle} className="flex items-center gap-2">
                        <Badge>{s.lifecycle}</Badge>
                        <span className="font-mono tabular-nums">{s.count}</span>
                      </div>
                    ))}
                  </dl>
                )}
              </CardContent>
            </Card>

            {/* Watched toggle */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Watched?</CardTitle>
                <CardDescription>
                  A <strong>watched</strong> scope nudges contributors to consider it when capturing
                  work. The Global scope (the doco's constitution) is always watched and cannot be
                  unwatched.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <WatchedSwitch
                  isWatched={scope.is_watched}
                  scopeName={scope.name}
                  locked={scope.name === "global"}
                />
              </CardContent>
            </Card>

            {/* Authoring rules */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  Authoring rules ({activeAuthoring.length}
                  {deprecatedAuthoring.length > 0 ? ` + ${deprecatedAuthoring.length} deprecated` : ""})
                </CardTitle>
                <CardDescription>
                  Predicates the engine evaluates whenever a node enters this scope. Deterministic
                  kinds block writes structurally; probabilistic specs run an LLM judge and reject
                  on a "no" verdict.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeAuthoring.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">No active authoring rules.</p>
                ) : (
                  <ul className="space-y-2">
                    {scope.authoring_rules.map((r, i) =>
                      isActive(ruleLifecycle(r)) ? (
                        <li
                          key={`a-${i}`}
                          className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                        >
                          <Badge>
                            Authoring · {r.kind === "probabilistic" ? "probabilistic" : "deterministic"}
                          </Badge>
                          <div className="flex-1 space-y-0.5">
                            <div className="text-foreground">{describeAuthoringRule(r, allScopes)}</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {predicateShorthand(r, allScopes)}
                            </div>
                          </div>
                          <Form method="post">
                            <input type="hidden" name="intent" value="deprecate_authoring_rule" />
                            <input type="hidden" name="rule_index" value={String(i)} />
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                            >
                              Deprecate
                            </button>
                          </Form>
                        </li>
                      ) : null,
                    )}
                  </ul>
                )}
                {deprecatedAuthoring.length > 0 ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Show deprecated ({deprecatedAuthoring.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {scope.authoring_rules.map((r, i) =>
                        isActive(ruleLifecycle(r)) ? null : (
                          <li
                            key={`a-dep-${i}`}
                            className="flex items-baseline gap-2 rounded-md border border-border bg-card/50 p-2 text-xs opacity-60"
                          >
                            <Badge>{ruleLifecycle(r)}</Badge>
                            <div className="flex-1 space-y-0.5">
                              <div className="text-foreground line-through">
                                {describeAuthoringRule(r, allScopes)}
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {predicateShorthand(r, allScopes)}
                              </div>
                            </div>
                            <Form method="post">
                              <input type="hidden" name="intent" value="reactivate_authoring_rule" />
                              <input type="hidden" name="rule_index" value={String(i)} />
                              <button
                                type="submit"
                                className="rounded-md border border-border px-2 py-0.5 text-[10px] text-foreground hover:bg-card"
                              >
                                Reactivate
                              </button>
                            </Form>
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                ) : null}
              </CardContent>
            </Card>

            {/* Guidance rules */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  Guidance rules ({activeGuidance.length}
                  {deprecatedGuidance.length > 0 ? ` + ${deprecatedGuidance.length} deprecated` : ""})
                </CardTitle>
                <CardDescription>
                  Prose the agent reads while working in or with this scope. No automated check —
                  directive but not enforced.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeGuidance.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">No active guidance rules.</p>
                ) : (
                  <ul className="space-y-2">
                    {scope.guidance_rules.map((r, i) =>
                      isActive(ruleLifecycle(r)) ? (
                        <li
                          key={`g-${i}`}
                          className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                        >
                          <Badge>Guidance</Badge>
                          <div className="flex-1 text-foreground whitespace-pre-wrap">{r.text}</div>
                          <Form method="post">
                            <input type="hidden" name="intent" value="deprecate_guidance_rule" />
                            <input type="hidden" name="rule_index" value={String(i)} />
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                            >
                              Deprecate
                            </button>
                          </Form>
                        </li>
                      ) : null,
                    )}
                  </ul>
                )}
                {deprecatedGuidance.length > 0 ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Show deprecated ({deprecatedGuidance.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {scope.guidance_rules.map((r, i) =>
                        isActive(ruleLifecycle(r)) ? null : (
                          <li
                            key={`g-dep-${i}`}
                            className="flex items-baseline gap-2 rounded-md border border-border bg-card/50 p-2 text-xs opacity-60"
                          >
                            <Badge>{ruleLifecycle(r)}</Badge>
                            <div className="flex-1 text-foreground whitespace-pre-wrap line-through">
                              {r.text}
                            </div>
                            <Form method="post">
                              <input type="hidden" name="intent" value="reactivate_guidance_rule" />
                              <input type="hidden" name="rule_index" value={String(i)} />
                              <button
                                type="submit"
                                className="rounded-md border border-border px-2 py-0.5 text-[10px] text-foreground hover:bg-card"
                              >
                                Reactivate
                              </button>
                            </Form>
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                ) : null}
              </CardContent>
            </Card>

            {/* Tagged rules (first-class Rule entities tagged in_scope_of this scope) */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  Tagged rules ({activeTagged.length}
                  {deprecatedTagged.length > 0 ? ` + ${deprecatedTagged.length} deprecated` : ""})
                </CardTitle>
                <CardDescription>
                  Rule entities (first-class nodes in the doco's graph) tagged with this scope.
                  Authored as Rule nodes elsewhere; listed here for context. Deprecating updates
                  the Rule entity's lifecycle.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeTagged.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">No active tagged rules.</p>
                ) : (
                  <ul className="space-y-2">
                    {activeTagged.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                      >
                        <Badge>Rule</Badge>
                        <div className="flex-1">
                          <Link
                            to={entityUrl({ ownerSlug, docoSlug, nodeType: "rule", id: r.id })}
                            className="text-foreground hover:text-primary hover:underline"
                          >
                            {r.summary}
                          </Link>
                        </div>
                        <Form method="post">
                          <input type="hidden" name="intent" value="deprecate_tagged_rule" />
                          <input type="hidden" name="rule_id" value={r.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-border px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                          >
                            Deprecate
                          </button>
                        </Form>
                      </li>
                    ))}
                  </ul>
                )}
                {deprecatedTagged.length > 0 ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Show deprecated ({deprecatedTagged.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {deprecatedTagged.map((r) => (
                        <li
                          key={r.id}
                          className="flex items-baseline gap-2 rounded-md border border-border bg-card/50 p-2 text-xs opacity-60"
                        >
                          <Badge>{r.lifecycle}</Badge>
                          <div className="flex-1">
                            <Link
                              to={entityUrl({ ownerSlug, docoSlug, nodeType: "rule", id: r.id })}
                              className="text-foreground line-through hover:text-primary hover:no-underline"
                            >
                              {r.summary}
                            </Link>
                          </div>
                          <Form method="post">
                            <input type="hidden" name="intent" value="reactivate_tagged_rule" />
                            <input type="hidden" name="rule_id" value={r.id} />
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-0.5 text-[10px] text-foreground hover:bg-card"
                            >
                              Reactivate
                            </button>
                          </Form>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </CardContent>
            </Card>

            {/* Add rules — single prose textarea + classifier preview */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Add rules</CardTitle>
                <CardDescription>
                  Describe one or more rules in plain English. The classifier splits multi-rule
                  prose, buckets each into authoring or guidance, and shows a preview before saving.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RuleProseEditor allScopes={allScopes} />
              </CardContent>
            </Card>

            {/* Icon */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Icon</CardTitle>
                <CardDescription>
                  Identifies the scope at a glance — on /scopes, in capture footers, and on entity
                  detail pages.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Form method="post" className="space-y-2">
                  <input type="hidden" name="intent" value="save_icon" />
                  <EmojiPickerInput name="icon" defaultValue={scope.icon} />
                  <div>
                    <button
                      type="submit"
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                    >
                      Save icon
                    </button>
                  </div>
                </Form>
              </CardContent>
            </Card>

            {/* Deprecate scope (link to standalone confirmation page) */}
            {scope.name === "global" ? null : (
              <Card className="border-destructive/40">
                <CardHeader>
                  <CardTitle className="text-sm text-destructive">Deprecate scope</CardTitle>
                  <CardDescription>
                    Retire this scope. Existing members keep their tag and remain queryable, but
                    new captures referencing this scope are rejected. Standalone confirmation
                    page — no destructive action here.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Link
                    to={`/${ownerSlug}/${docoSlug}/scopes/${scope.id}/deprecate`}
                    className="inline-flex items-center rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
                  >
                    Deprecate scope →
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right column — activity heatmap + feed */}
          <aside className="min-[840px]:col-span-5 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Activity</CardTitle>
                <CardDescription>
                  Captures tagged with this scope over the last {HEATMAP_WEEKS} weeks.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Latest activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-muted-foreground">
                    No nodes tagged with this scope yet.
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {items.map((it) => (
                      <li key={it.id} className="px-4 py-2 text-xs">
                        <Link
                          to={entityUrl({
                            ownerSlug,
                            docoSlug,
                            nodeType: it.node_type,
                            id: it.id,
                          })}
                          className="flex items-baseline gap-2 hover:text-primary"
                        >
                          <span className="font-mono text-[10px] uppercase text-muted-foreground">
                            {it.node_type}
                          </span>
                          <span className="flex-1 truncate text-foreground">{it.summary}</span>
                          <Badge>{it.lifecycle}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}

/**
 * Watched-flag toggle — auto-saves on change. Locked + always-on for the
 * Global scope (the doco's constitution) per
 * decision_01KRKS5H2A5QER84CJ8R4VD36Z.
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
          Always watched — the Global scope (the doco's constitution) is a framework invariant.
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
          fetcher.submit(
            { intent: "set_watched", watched: String(next) },
            { method: "post" },
          );
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

/**
 * Prose rule editor — single textarea + classifier preview + accept.
 * See decision_01KRPET95G2QNTPCR0YWAKSCH5 (prose-driven rule authoring)
 * and decision_01KRPNZY7W6CCMYNKGND67BP0B (extended to bucket into
 * authoring + guidance, with lifecycle on each rule).
 */
function RuleProseEditor({ allScopes }: { allScopes: { id: string; name: string }[] }) {
  const fetcher = useFetcher<{
    classified?: ClassifiedRule[];
    originalProse?: string;
    ok?: boolean;
    added_authoring?: number;
    added_guidance?: number;
    error?: string;
  }>();
  const [prose, setProse] = useState("");
  const [hidePreview, setHidePreview] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok === true) {
      setProse("");
      setHidePreview(true);
    }
  }, [fetcher.state, fetcher.data]);

  const isClassifying =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "classify_rule_prose";
  const isSaving =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "add_rules_classified";
  const classified = fetcher.data?.classified;
  const classifyError =
    fetcher.data?.error && fetcher.data?.classified === undefined ? fetcher.data.error : null;
  const inPreview = !hidePreview && Array.isArray(classified) && classified.length > 0;
  const authoringCount = classified?.filter((c) => c.bucket === "authoring").length ?? 0;
  const guidanceCount = classified?.filter((c) => c.bucket === "guidance").length ?? 0;

  return (
    <div className="rounded-md border border-dashed border-border bg-input/30 p-3 space-y-2">
      {inPreview ? (
        <fetcher.Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="add_rules_classified" />
          <input type="hidden" name="payload" value={JSON.stringify(classified)} />
          <p className="text-[11px] text-muted-foreground">
            The classifier produced{" "}
            <strong>
              {authoringCount} authoring rule{authoringCount === 1 ? "" : "s"}
            </strong>{" "}
            and{" "}
            <strong>
              {guidanceCount} guidance rule{guidanceCount === 1 ? "" : "s"}
            </strong>
            . Review and accept, or cancel to edit your prose.
          </p>
          <ul className="space-y-2">
            {classified!.map((c, i) => {
              if (c.bucket === "guidance") {
                return (
                  <li
                    key={i}
                    className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                  >
                    <Badge>Guidance</Badge>
                    <div className="flex-1 text-foreground whitespace-pre-wrap">{c.text}</div>
                  </li>
                );
              }
              const isProbabilistic = c.rule.kind === "probabilistic";
              const asRecord = c.rule as unknown as AuthoringRuleRecord;
              return (
                <li
                  key={i}
                  className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                >
                  <Badge>
                    Authoring · {isProbabilistic ? "probabilistic" : "deterministic"}
                  </Badge>
                  <div className="flex-1 space-y-0.5">
                    <div className="text-foreground">{c.text}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {predicateShorthand(asRecord, allScopes)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {fetcher.data?.error && fetcher.data?.classified !== undefined ? (
            <p className="text-[11px] text-destructive">{fetcher.data.error}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSaving
                ? "Saving…"
                : `Accept & add ${classified!.length} rule${classified!.length === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              onClick={() => setHidePreview(true)}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-card"
            >
              Cancel
            </button>
          </div>
        </fetcher.Form>
      ) : (
        <fetcher.Form
          method="post"
          className="space-y-2"
          onSubmit={() => setHidePreview(false)}
        >
          <input type="hidden" name="intent" value="classify_rule_prose" />
          <label className="block text-xs">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              Rule prose
            </span>
            <textarea
              name="prose"
              rows={3}
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              placeholder="e.g. Every Decision should have an Intent, and bugs should link to a Rule."
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            />
          </label>
          {classifyError ? <p className="text-[11px] text-destructive">{classifyError}</p> : null}
          <div>
            <button
              type="submit"
              disabled={isClassifying || prose.trim().length === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isClassifying ? "Classifying…" : "Classify with LLM"}
            </button>
          </div>
        </fetcher.Form>
      )}
    </div>
  );
}
