// /<owner>/<doco>/scopes/<id> — merged scope detail + edit page.
//
// Per decision_01KRPNZY7W6CCMYNKGND67BP0B the separate detail and edit
// pages collapsed into this one. Per
// decision_01KRPRDR1AD7S1RP6E69BQDB2G the three rule groups on this page
// (Authoring / Guidance / Tagged) are all first-class Rule entities now:
// rows in the `rules` table with an `in_scope_of` edge to this scope.
// The Rule's `kind` field discriminates the role; deprecate / reactivate
// is a regular Rule PATCH (lifecycle = abandoned / active).
//
// Layout: two columns. Left carries Members stats + Watched toggle + the
// three rule sections + Add rules (prose classifier) + Icon + Deprecate
// scope link. Right carries activity heatmap + scope-filtered latest
// activity feed.

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
import { updateEntity } from "~/lib/capture.server";
import {
  createRuleInDoco,
  reindex,
  setScopeWatchedInDoco,
  updateScopeInDoco,
} from "~/lib/redeem.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";

const HEATMAP_WEEKS = 26;

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
}

interface RuleRecord {
  id: string;
  summary: string;
  lifecycle: string;
  kind: RuleKind;
  predicate?: AuthoringPredicateRecord;
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

  const meta = await readDocoMetadata(dir);
  const docoId = meta?.docoId ?? null;

  // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G all rule groups are
  // first-class Rule entities now. One query, then we bucket in code.
  type Row = { id: string; summary: string; lifecycle: string; raw_yaml: string };
  const ruleRows: Row[] = docoId
    ? await withClient(async (c) => {
        const r = await c.query<Row>(
          `SELECT r.id, r.summary, COALESCE(r.lifecycle, 'active') AS lifecycle, r.raw_yaml
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
    const kind: RuleKind =
      fm.kind === "authoring" || fm.kind === "guidance" ? (fm.kind as RuleKind) : "tagged";
    const predicate = fm.predicate as AuthoringPredicateRecord | undefined;
    rulesByKind[kind].push({
      id: row.id,
      summary: row.summary,
      lifecycle: row.lifecycle,
      kind,
      ...(predicate && typeof predicate === "object" ? { predicate } : {}),
    });
  }

  // Stats: count entities tagged with this scope by lifecycle.
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
          "rules",
          "reasoning",
          "evals",
          "ideas",
          "reference_entities",
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

  // Latest 30 entities tagged with this scope, for the feed.
  type FeedItem = {
    id: string;
    node_type: string;
    summary: string;
    lifecycle: string;
    created_at: string;
  };
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
      is_watched: isWatched,
    },
    rules: rulesByKind,
    allScopes,
    memberCount,
    memberStats,
    byDay,
    items,
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
      // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G classified rules become
      // first-class Rule entities (one per classified row) tagged with
      // the scope. The classifier output shape is unchanged; the
      // persistence layer creates entities instead of mutating arrays.
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
      let addedAuthoring = 0;
      let addedGuidance = 0;
      for (const c of parsed) {
        if (c.bucket === "guidance") {
          if (c.text.trim()) {
            await createRuleInDoco({
              docoId: meta.docoId as EntityId<"doco">,
              kind: "guidance",
              summary: c.text.trim(),
              scopeId,
              createdBy: null,
            });
            addedGuidance++;
          }
        } else {
          await createRuleInDoco({
            docoId: meta.docoId as EntityId<"doco">,
            kind: "authoring",
            summary: c.text.trim() || `Authoring rule (${c.rule.kind})`,
            predicate: c.rule,
            scopeId,
            createdBy: null,
          });
          addedAuthoring++;
        }
      }
      await reindex(dir);
      return { ok: true, added_authoring: addedAuthoring, added_guidance: addedGuidance };
    } else if (intent === "deprecate_rule" || intent === "reactivate_rule") {
      // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G deprecating any rule
      // (authoring, guidance, or tagged) is the same operation: PATCH the
      // Rule entity's lifecycle.
      const ruleId = String(form.get("rule_id") ?? "");
      if (!ruleId.startsWith("rule_")) {
        return { error: "rule_id missing or malformed." };
      }
      const nextLifecycle = intent === "deprecate_rule" ? "abandoned" : "active";
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

function describeAuthoringPredicate(
  p: AuthoringPredicateRecord,
  allScopes: { id: string; name: string }[],
): string {
  switch (p.kind) {
    case "requires_edge":
      return `Nodes must have an outgoing \`${p.edge_type}\` edge${p.target_node_type ? ` to a ${p.target_node_type}` : ""}.`;
    case "forbids_edge":
      return `Nodes must NOT have a \`${p.edge_type}\` edge${p.target_node_type ? ` to a ${p.target_node_type}` : ""}.`;
    case "requires_field": {
      const fields = asFieldList(p);
      if (fields.length === 0) return `Nodes must declare a field.`;
      if (fields.length === 1) return `Nodes must declare the \`${fields[0]}\` field.`;
      return `Nodes must declare these fields: ${fields.map((f) => `\`${f}\``).join(", ")}.`;
    }
    case "forbids_field": {
      const fields = asFieldList(p);
      if (fields.length === 0) return `Nodes must NOT declare a field.`;
      return `Nodes must NOT declare these fields: ${fields.map((f) => `\`${f}\``).join(", ")}.`;
    }
    case "mandatory_scope": {
      const names = asScopeIdList(p).map(
        (id) => allScopes.find((s) => s.id === id)?.name ?? id,
      );
      if (names.length === 0) return `Every node in this Doco must list a scope.`;
      if (names.length === 1)
        return `Every node in this Doco must list scope \`${names[0]}\`.`;
      return `Every node in this Doco must list these scopes: ${names
        .map((n) => `\`${n}\``)
        .join(", ")}.`;
    }
    case "probabilistic":
      return `LLM-judged: ${p.spec}`;
    default:
      return `(${p.kind})`;
  }
}

function predicateShorthand(
  p: AuthoringPredicateRecord,
  allScopes: { id: string; name: string }[],
): string {
  switch (p.kind) {
    case "requires_edge":
      return `requires \`${p.edge_type ?? "?"}\`${p.target_node_type ? ` → ${p.target_node_type}` : ""}`;
    case "forbids_edge":
      return `forbids \`${p.edge_type ?? "?"}\`${p.target_node_type ? ` → ${p.target_node_type}` : ""}`;
    case "requires_field":
      return `requires fields: ${asFieldList(p).join(", ") || "—"}`;
    case "forbids_field":
      return `forbids fields: ${asFieldList(p).join(", ") || "—"}`;
    case "mandatory_scope": {
      const names = asScopeIdList(p).map(
        (id) => allScopes.find((s) => s.id === id)?.name ?? id,
      );
      return `mandatory scope: ${names.join(", ") || "—"}`;
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
  const { ownerSlug, docoSlug, scope, rules, allScopes, memberCount, memberStats, byDay, items, me } =
    loaderData;

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
              <span className="ml-2 text-xs text-muted-foreground">
                (the doco's constitution)
              </span>
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
            {/* Stats */}
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

            <RuleSectionCard
              title="Authoring rules"
              description={
                "Predicates the engine evaluates whenever a node enters this scope. Deterministic kinds block writes structurally; probabilistic specs run an LLM judge and reject on a “no” verdict."
              }
              kind="authoring"
              rules={rules.authoring}
              allScopes={allScopes}
              ownerSlug={ownerSlug}
              docoSlug={docoSlug}
            />

            <RuleSectionCard
              title="Guidance rules"
              description={
                "Prose the agent reads while working in or with this scope. No automated check — directive but not enforced."
              }
              kind="guidance"
              rules={rules.guidance}
              allScopes={allScopes}
              ownerSlug={ownerSlug}
              docoSlug={docoSlug}
            />

            <RuleSectionCard
              title="Tagged rules"
              description={
                "Rule entities authored elsewhere and tagged with this scope. Deprecate / reactivate behaves the same as for Authoring + Guidance rules — all three are Rule entities now (decision_01KRPRDR1AD7S1RP6E69BQDB2G)."
              }
              kind="tagged"
              rules={rules.tagged}
              allScopes={allScopes}
              ownerSlug={ownerSlug}
              docoSlug={docoSlug}
            />

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Add rules</CardTitle>
                <CardDescription>
                  Describe one or more rules in plain English. The classifier splits multi-rule
                  prose, buckets each into authoring or guidance, and shows a preview before
                  saving.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RuleProseEditor allScopes={allScopes} />
              </CardContent>
            </Card>

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

            {scope.name === "global" ? null : (
              <Card className="border-destructive/40">
                <CardHeader>
                  <CardTitle className="text-sm text-destructive">Deprecate scope</CardTitle>
                  <CardDescription>
                    Retire this scope. Existing members keep their tag and remain queryable, but
                    new captures referencing this scope are rejected.
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

function RuleSectionCard({
  title,
  description,
  kind,
  rules,
  allScopes,
  ownerSlug,
  docoSlug,
}: {
  title: string;
  description: string;
  kind: RuleKind;
  rules: RuleRecord[];
  allScopes: { id: string; name: string }[];
  ownerSlug: string;
  docoSlug: string;
}) {
  const active = rules.filter((r) => isActive(r.lifecycle));
  const deprecated = rules.filter((r) => !isActive(r.lifecycle));
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
        <CardTitle className="text-sm">
          {title} ({active.length}
          {deprecated.length > 0 ? ` + ${deprecated.length} deprecated` : ""})
        </CardTitle>
        <CardDescription>{description}</CardDescription>
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
                  {r.predicate ? (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {predicateShorthand(r.predicate, allScopes)}
                    </div>
                  ) : null}
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="deprecate_rule" />
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
        {deprecated.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Show deprecated ({deprecated.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {deprecated.map((r) => (
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
                    {r.predicate ? (
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {predicateShorthand(r.predicate, allScopes)}
                      </div>
                    ) : null}
                  </div>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reactivate_rule" />
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
  );
}

/**
 * Watched-flag toggle — auto-saves on change. Locked + always-on for the
 * Global scope (the doco's constitution).
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
 * Per decision_01KRPRDR1AD7S1RP6E69BQDB2G the server creates Rule
 * entities (one per classified row) instead of pushing onto embedded
 * arrays. The UI shape is unchanged from
 * decision_01KRPNZY7W6CCMYNKGND67BP0B.
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
              const asRecord = c.rule as unknown as AuthoringPredicateRecord;
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
