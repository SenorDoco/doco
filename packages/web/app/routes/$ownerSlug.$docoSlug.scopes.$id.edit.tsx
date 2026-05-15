// /<owner>/<doco>/scopes/<id>/edit — standalone scope-edit page.
//
// Surfaces the three editable parts of a Scope:
//   - Purpose (single-line description of why this scope exists)
//   - Guidelines (markdown body — how to author nodes in this scope)
//   - Rules (deterministic + probabilistic predicates the engine evaluates
//            on every capture into this scope). Add/remove one at a time,
//            email-filter style.
//
// The bottom of the page is a Danger Zone — the ONLY place a scope can
// be deleted (ADR-084 follow-up). Empty scopes confirm with a button;
// non-empty scopes require typing the scope name verbatim.
//
// Saving each section is a separate form POST; nothing is persisted
// until you press Save / Add / Remove / Delete. Cancel returns to /scopes.
import { useEffect, useState } from "react";
import { Form, Link, redirect, useFetcher } from "react-router";
import { parse as parseYaml } from "yaml";
import type { EntityId } from "@doco/shared";
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
import { listScopeDetails, listScopeManifest, readDocoMetadata } from "~/lib/scope-helpers.server";

interface ScopeRuleRecord {
  kind: string;
  edge_type?: string;
  target_node_type?: string;
  // Plural is the canonical shape for requires_field / forbids_field /
  // mandatory_scope (one rule can declare several mandatory fields or
  // mandatory scopes). The singular `field` / `scope_id` keys remain on
  // the type only so the loader can read pre-plural YAML; we never write
  // them.
  field?: string;
  fields?: string[];
  scope_id?: string;
  scope_ids?: string[];
  spec?: string;
  reason?: string;
}

function asFieldList(r: ScopeRuleRecord): string[] {
  if (Array.isArray(r.fields)) return r.fields.filter((f): f is string => typeof f === "string");
  if (typeof r.field === "string" && r.field.length > 0) return [r.field];
  return [];
}

function asScopeIdList(r: ScopeRuleRecord): string[] {
  if (Array.isArray(r.scope_ids))
    return r.scope_ids.filter((s): s is string => typeof s === "string");
  if (typeof r.scope_id === "string" && r.scope_id.length > 0) return [r.scope_id];
  return [];
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
      // raw_yaml is JSON for new writes (decision_01KRPJ6ZGR36WR8165CXABBEH5)
      // but parseYaml accepts JSON too — handles both transparently.
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

  // All scopes — needed for the mandatory_scope rule's scope_id dropdown
  // and for computing child-scope refbacks (Danger Zone).
  const allScopeDetails = await listScopeDetails(dir);
  const allScopes = allScopeDetails.map((s) => ({ id: s.id, name: s.name }));
  const childNames = allScopeDetails.filter((s) => s.parent_ids.includes(id)).map((s) => s.name);

  // Per ADR-137bis the watched flag is editable on every scope-management
  // surface. We read it from the scope's own YAML via the manifest helper.
  const manifest = await listScopeManifest(dir);
  const isWatched = manifest.find((m) => m.id === id)?.is_watched ?? false;

  // Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA the scope carries two parallel
  // rule arrays. `authoring_rules` are engine-readable predicates that fire
  // at write time; `guidance_rules` are prose strings the agent reads.
  const authoringRules: ScopeRuleRecord[] = Array.isArray(raw.authoring_rules)
    ? (raw.authoring_rules as ScopeRuleRecord[])
    : [];
  const guidanceRules: string[] = Array.isArray(raw.guidance_rules)
    ? (raw.guidance_rules as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  // memberCount — non-scope nodes that name this scope via in_scope_of.
  let memberCount = 0;
  try {
    const meta = await readDocoMetadata(dir);
    if (meta?.docoId) {
      memberCount = await withClient(async (c) => {
        const r = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM edges
            WHERE to_id = $1
              AND edge_type = 'in_scope_of'
              AND from_node_type != 'scope'
              AND doco_id = $2`,
          [id, meta.docoId],
        );
        return Number(r.rows[0]?.n ?? 0);
      });
    }
  } catch {
    /* PG unreachable — treat as zero */
  }

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
    childNames,
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
  const { dir } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scopeId = id as EntityId<"scope">;
  const back = `/${ownerSlug}/${docoSlug}/scopes/${id}/edit`;

  try {
    if (intent === "set_watched") {
      // Per ADR-137bis — the watched flag is a soft attention signal
      // stored directly on the scope's YAML. No Constitution rule
      // mutation, no enforcement at capture time.
      const watchedRaw = String(form.get("watched") ?? "");
      if (watchedRaw !== "true" && watchedRaw !== "false") {
        return {
          error: "Pick watched or not watched — no default per ADR-137bis.",
        };
      }
      // Fifth framework-native behavior of the Constitution scope
      // (decision_01KRKS5H2A5QER84CJ8R4VD36Z): always watched.
      const raw = await readScopeRaw(id);
      if (raw && raw.name === "constitution" && watchedRaw === "false") {
        return {
          error:
            "The Constitution scope is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
        };
      }
      await setScopeWatchedInDoco({
        docoDir: dir,
        targetScopeId: scopeId,
        watched: watchedRaw === "true",
      });
    } else if (intent === "save_icon") {
      // Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA the scope no longer
      // carries `purpose` or `guidelines` fields — everything other than
      // the icon is rules. So this intent only saves the icon.
      const icon = String(form.get("icon") ?? "").trim();
      await updateScopeInDoco({ docoDir: dir, scopeId, icon: icon || null });
    } else if (intent === "classify_rule_prose") {
      // The new prose-driven flow (decision_01KRPET95G2QNTPCR0YWAKSCH5).
      // Fetcher-only path: returns the classified rules without persisting
      // so the form can show a preview before the project owner accepts.
      // No reindex, no redirect.
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
      const existingAuthoring: ScopeRuleRecord[] = Array.isArray(raw.authoring_rules)
        ? (raw.authoring_rules as ScopeRuleRecord[])
        : [];
      const existingGuidance: string[] = Array.isArray(raw.guidance_rules)
        ? (raw.guidance_rules as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const newAuthoring: ScopeRuleRecord[] = [];
      const newGuidance: string[] = [];
      for (const c of parsed) {
        if (c.bucket === "guidance") {
          if (c.text.trim()) newGuidance.push(c.text.trim());
          continue;
        }
        // Persist the original prose as `reason` so the rule list shows the
        // project owner's own words next to the predicate shorthand. For
        // probabilistic rules the spec IS the prose, so reason stays
        // whatever the classifier set (if anything) to avoid duplication.
        const base: ScopeRuleRecord = { ...(c.rule as unknown as ScopeRuleRecord) };
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
      // Fetcher-only path — returning data instead of redirecting lets the
      // editor component reset its preview state and React Router
      // revalidate the loader so the new rules show in the list above.
      return {
        ok: true,
        added_authoring: newAuthoring.length,
        added_guidance: newGuidance.length,
      };
    } else if (intent === "remove_authoring_rule") {
      const indexStr = String(form.get("rule_index") ?? "");
      const index = Number.parseInt(indexStr, 10);
      if (!Number.isInteger(index) || index < 0) return { error: "Invalid rule index." };
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const existing: ScopeRuleRecord[] = Array.isArray(raw.authoring_rules)
        ? (raw.authoring_rules as ScopeRuleRecord[])
        : [];
      if (index >= existing.length) return { error: "Rule index out of range." };
      const next = existing.filter((_, i) => i !== index);
      await updateScopeInDoco({
        docoDir: dir,
        scopeId,
        authoring_rules: next.length === 0 ? null : next,
      });
    } else if (intent === "remove_guidance_rule") {
      const indexStr = String(form.get("rule_index") ?? "");
      const index = Number.parseInt(indexStr, 10);
      if (!Number.isInteger(index) || index < 0) return { error: "Invalid rule index." };
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const existing: string[] = Array.isArray(raw.guidance_rules)
        ? (raw.guidance_rules as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      if (index >= existing.length) return { error: "Rule index out of range." };
      const next = existing.filter((_, i) => i !== index);
      await updateScopeInDoco({
        docoDir: dir,
        scopeId,
        guidance_rules: next.length === 0 ? null : next,
      });
    } else if (intent === "deprecate") {
      // Danger Zone — deprecate (don't delete) a scope. Per the
      // `scopes-are-deprecated-not-deleted` Decision: scopes follow the
      // same lifecycle model as every other node — they can transition
      // to a retired state, but they're never removed from disk.
      // Deprecated scopes keep their existing members; new captures
      // that reference them are rejected.
      //
      // Server-side guards (don't trust the client):
      //   1. Block if any non-deprecated child scope names this one as
      //      a parent — children would be left pointing at an inactive
      //      ancestor.
      //   2. If the scope has member nodes, require the confirm_name
      //      field to match the scope's name verbatim. Empty scopes
      //      confirm with no name match.
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      const scopeName = String(raw.name);

      const allScopeDetails = await listScopeDetails(dir);
      const children = allScopeDetails.filter((s) => s.parent_ids.includes(id));
      if (children.length > 0) {
        return {
          error: `Can't deprecate: ${children.length} child scope(s) depend on this. Reparent or deprecate them first: ${children.map((s) => s.name).join(", ")}`,
        };
      }

      let memberCount = 0;
      try {
        const meta = await readDocoMetadata(dir);
        if (meta?.docoId) {
          memberCount = await withClient(async (c) => {
            const r = await c.query<{ n: string }>(
              `SELECT COUNT(*)::text AS n FROM edges
                WHERE to_id = $1
                  AND edge_type = 'in_scope_of'
                  AND from_node_type != 'scope'
                  AND doco_id = $2`,
              [id, meta.docoId],
            );
            return Number(r.rows[0]?.n ?? 0);
          });
        }
      } catch {
        /* PG unreachable — treat as zero */
      }

      if (memberCount > 0) {
        const confirmName = String(form.get("confirm_name") ?? "").trim();
        if (confirmName !== scopeName) {
          return {
            error: `Type the scope name "${scopeName}" exactly to confirm deprecating a non-empty scope.`,
          };
        }
      }

      await updateScopeInDoco({ docoDir: dir, scopeId, lifecycle: "abandoned" });
    } else if (intent === "reactivate") {
      // Lift a scope out of retired state. No guard rails — bringing
      // an empty scope back is cheap, and bringing a non-empty one back
      // just resumes accepting new members (existing ones weren't lost).
      await updateScopeInDoco({ docoDir: dir, scopeId, lifecycle: "active" });
    } else {
      return { error: `Unknown intent: ${intent}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(dir);
  // set_watched is the only intent submitted via fetcher (the toggle on
  // both the list page and this page auto-saves). Returning data instead
  // of a redirect keeps the user on the page and just revalidates loader
  // data; a redirect here would yank the list page over to /scopes/<id>/edit.
  if (intent === "set_watched") return { ok: true };
  return redirect(back);
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string; id: string } }) {
  return [{ title: `Edit scope · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

function describeRule(r: ScopeRuleRecord, allScopes: { id: string; name: string }[]): string {
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
      if (fields.length === 1) return `Nodes must NOT declare the \`${fields[0]}\` field.`;
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

export default function ScopeEdit({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, scope, allScopes, memberCount, childNames, host, me } = loaderData;

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
            Edit scope · {scope.icon ? <span className="mr-1">{scope.icon}</span> : null}
            <span className="font-mono">{scope.name}</span>
          </h1>
          <Link
            to={`/${ownerSlug}/${docoSlug}/scopes`}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to scopes
          </Link>
        </div>

        {/* Icon — the only non-rule scalar a scope carries.
            Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA `purpose` and
            `guidelines` were retired; every other piece of normative
            content lives as a rule below. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Icon</CardTitle>
            <CardDescription>
              The icon identifies the scope at a glance — it surfaces on the /scopes list, the
              /constitution tab, and on every capture footer that touches a node in this scope.
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

        {/* Watched toggle — per ADR-137bis. Auto-saves on change.
            The Constitution scope is always watched (framework
            invariant per decision_01KRKS5H2A5QER84CJ8R4VD36Z) — the
            toggle is locked-on for it. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Watched?</CardTitle>
            <CardDescription>
              A <strong>watched</strong> scope is a soft attention signal for
              contributors (person or agent): "when capturing work, scan against
              this scope and tag the new node into it if it fits." Stored as a{" "}
              <code>watched: true</code> flag on the scope's own YAML. Not
              enforced at capture time — for hard enforcement, add a{" "}
              <code>mandatory_scope</code> rule to the Constitution via the
              Authoring rules editor below (a different mechanism).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WatchedSwitch
              isWatched={scope.is_watched}
              scopeName={scope.name}
              locked={scope.name === "constitution"}
            />
          </CardContent>
        </Card>

        {/* Authoring rules — engine-readable predicates fired at write
            time. Failures block the write. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Authoring rules ({scope.authoring_rules.length})
            </CardTitle>
            <CardDescription>
              Predicates the engine evaluates whenever a node enters this scope. Deterministic kinds
              (requires_edge / requires_field / mandatory_scope / forbids_*) block writes
              structurally; probabilistic specs run an LLM judge at capture time and reject on a
              "no" verdict. Authored via prose below — the classifier picks the predicate.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scope.authoring_rules.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                No authoring rules yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {scope.authoring_rules.map((r, i) => {
                  const isProbabilistic = r.kind === "probabilistic";
                  const shorthand = predicateShorthand(r, allScopes);
                  return (
                    <li
                      key={`${r.kind}-${i}`}
                      className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                    >
                      <Badge>{isProbabilistic ? "Probabilistic" : "Deterministic"}</Badge>
                      <div className="flex-1 space-y-0.5">
                        <div className="text-foreground">{describeRule(r, allScopes)}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {shorthand}
                        </div>
                      </div>
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove_authoring_rule" />
                        <input type="hidden" name="rule_index" value={String(i)} />
                        <button
                          type="submit"
                          className="rounded-md border border-border px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                        >
                          Remove
                        </button>
                      </Form>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Guidance rules — prose for agents to read while working in or
            with this scope. No automated check. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Guidance rules ({scope.guidance_rules.length})
            </CardTitle>
            <CardDescription>
              Prose the agent reads while working in or with this scope. No automated check —
              directive but not enforced. Use these for procedural / stylistic / informational rules
              that don't fit an authoring predicate ("when writing a bugfix Decision, lead with the
              symptom"; "format Decision bodies with sections: Context, Options, Choice,
              Consequences").
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scope.guidance_rules.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                No guidance rules yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {scope.guidance_rules.map((text, i) => (
                  <li
                    key={`guidance-${i}`}
                    className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                  >
                    <Badge>Guidance</Badge>
                    <div className="flex-1 text-foreground whitespace-pre-wrap">{text}</div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_guidance_rule" />
                      <input type="hidden" name="rule_index" value={String(i)} />
                      <button
                        type="submit"
                        className="rounded-md border border-border px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                      >
                        Remove
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Add rules — one prose textarea; classifier buckets into
            authoring or guidance and lets the project owner preview. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Add rules</CardTitle>
            <CardDescription>
              Describe one or more rules in plain English. The classifier splits multi-rule prose,
              buckets each into authoring (engine-readable predicates that block writes) or
              guidance (prose for agents to read), and shows you a preview before saving.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RuleProseEditor allScopes={allScopes} />
          </CardContent>
        </Card>

        {/* Danger Zone — the only place a scope can be deleted. */}
        <DangerZone
          scopeName={scope.name}
          memberCount={memberCount}
          childNames={childNames}
          lifecycle={scope.lifecycle}
        />
      </main>
    </div>
  );
}

/**
 * Auto-saves the watched flag on change — no Save button, no radios.
 * Optimistic UI: while the fetcher is in flight, render the requested
 * value so the toggle feels instant.
 *
 * When `locked` is true (Constitution scope per
 * decision_01KRKS5H2A5QER84CJ8R4VD36Z), the toggle renders disabled,
 * always-on, with explanatory text — clicks are no-ops and there's no
 * submit path to even reach the server guard.
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
          Always watched — the Constitution scope is a framework invariant
          (cannot be unwatched).
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
 * Single funnel for scope deletion. Three states:
 *
 *   - Has child scopes → blocked (must reparent children first).
 *   - No children, no members → simple confirm button.
 *   - No children, has members → require typing the exact scope name to
 *     submit; the Submit button stays disabled until the typed value
 *     matches, and the server re-checks the name as a defense in depth.
 */
function DangerZone({
  scopeName,
  memberCount,
  childNames,
  lifecycle,
}: {
  scopeName: string;
  memberCount: number;
  childNames: string[];
  lifecycle: string;
}) {
  const [typed, setTyped] = useState("");
  const hasChildren = childNames.length > 0;
  const hasMembers = memberCount > 0;
  const isDeprecated = lifecycle !== "active" && lifecycle !== "proposed";
  const canSubmit = !hasChildren && (!hasMembers || typed.trim() === scopeName);

  // If already retired, surface a Reactivate path. Scopes are never
  // deleted (per the `scopes-are-deprecated-not-deleted` Decision); the
  // danger zone toggles the lifecycle between `active` and `abandoned`.
  if (isDeprecated) {
    return (
      <Card className="border-warn/40">
        <CardHeader>
          <CardTitle className="text-sm">Deprecated — danger zone</CardTitle>
          <CardDescription>
            This scope is deprecated. Existing members keep their tag, but new
            captures referencing it are rejected. Reactivate to start accepting
            members again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="reactivate" />
            <button
              type="submit"
              className="rounded-md border border-border bg-input px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-card"
            >
              Reactivate scope
            </button>
          </Form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-sm text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Deprecating a scope retires it — existing members keep their tag and
          remain queryable, but new captures referencing this scope are
          rejected. Scopes are never deleted; deprecation is the closest you
          get to "remove."
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasChildren ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Can't deprecate:{" "}
            {childNames.length === 1
              ? "1 child scope depends"
              : `${childNames.length} child scopes depend`}{" "}
            on this one — {childNames.map((n) => `\`${n}\``).join(", ")}.
            Reparent or deprecate them first.
          </div>
        ) : (
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="deprecate" />
            {hasMembers ? (
              <>
                <p className="text-xs text-foreground">
                  This scope has{" "}
                  <span className="font-semibold">{memberCount}</span>{" "}
                  {memberCount === 1 ? "node" : "nodes"} tagged with it. To
                  confirm deprecation, type the scope name{" "}
                  <span className="font-mono font-semibold">{scopeName}</span>{" "}
                  below.
                </p>
                <label className="block">
                  <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                    Type the scope name to confirm
                  </span>
                  <input
                    name="confirm_name"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    placeholder={scopeName}
                    className="w-full rounded-md border border-destructive/40 bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-destructive"
                  />
                </label>
              </>
            ) : (
              <p className="text-xs text-foreground">
                This scope is empty — no nodes are tagged with it. Press the
                button below to deprecate it. (You can reactivate later.)
              </p>
            )}
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {hasMembers ? "Deprecate scope" : "Deprecate empty scope"}
            </button>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Compact one-line description of a rule's predicate shape — shown as a
 * subtitle under the project owner's prose so the rule list makes the
 * engine semantics visible at a glance.
 */
function predicateShorthand(
  r: ScopeRuleRecord,
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

/**
 * Single-textarea rule editor (decision_01KRPET95G2QNTPCR0YWAKSCH5).
 *
 * Two-step flow on the web. Step 1 — the project owner types prose
 * describing one or more rules; the fetcher posts `classify_rule_prose`
 * and the server LLM (OpenAI) returns a typed `ClassifiedRule[]` (splitting
 * multi-rule prose and picking the most-fitting deterministic predicate
 * when one fits, otherwise falling back to probabilistic). Step 2 — the
 * preview UI shows what the classifier produced, with a Deterministic /
 * Probabilistic badge per row; clicking Accept POSTs `add_rules_classified`
 * (regular Form, redirects on success) to persist them.
 *
 * Classifier failure rejects the operation rather than silently saving
 * the prose as probabilistic — per decision_01KRPET95G2QNTPCR0YWAKSCH5
 * the host's OPENAI_API_KEY is now load-bearing, and degrading silently
 * would hide that.
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

  // When the accept fetcher succeeds, clear the local state so the form
  // resets to the empty prose textarea — the loader revalidates and the
  // new rule rows show in the lists above.
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
  const authoringCount =
    classified?.filter((c) => c.bucket === "authoring").length ?? 0;
  const guidanceCount =
    classified?.filter((c) => c.bucket === "guidance").length ?? 0;

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
              const asRecord = c.rule as unknown as ScopeRuleRecord;
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
            </button>{" "}
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

