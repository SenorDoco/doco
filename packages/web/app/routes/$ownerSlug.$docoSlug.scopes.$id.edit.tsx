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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
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

// Canonical lists shared by every rule-form dropdown. Keep these in sync with
// the index's FIELD_TO_EDGE_TYPE table (packages/index/src/edges.ts) and the
// entity discriminator (packages/shared/src/entities.ts).
const EDGE_TYPE_OPTIONS = [
  "serves",
  "consults",
  "enacts",
  "performed_by",
  "acts_on",
  "authored_by",
  "premise",
  "concludes",
  "has_parent",
  "has_stakeholder",
  "owned_by",
  "created_by",
  "updated_by",
  "born_from",
  "superseded_by",
  "in_scope_of",
  "member_of",
  "follows",
  "tests",
  "relates_to",
] as const;

const NODE_TYPE_OPTIONS = [
  "principal",
  "doco",
  "organization",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "eval",
  "reference",
  "scope",
] as const;

// Common frontmatter fields that a `requires_field` / `forbids_field` rule
// would reasonably target. The dropdown still allows "Other" for advanced
// users via the schema-free underlying YAML.
const FIELD_OPTIONS = [
  "summary",
  "slug",
  "lifecycle",
  "scopes",
  "intent_ids",
  "decision_ids",
  "rules_consulted",
  "stakeholders",
  "follows",
  "born_from",
  "superseded_by",
  "target_ref",
  "target",
  "actor_id",
  "author_id",
] as const;

function readScopeRaw(docoDir: string, scopeId: string): Record<string, unknown> | null {
  try {
    const path = join(docoDir, "scopes", `${scopeId}.yaml`);
    const text = readFileSync(path, "utf8");
    return parseYaml(text) as Record<string, unknown>;
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
  const raw = readScopeRaw(dir, id);
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

  const rules: ScopeRuleRecord[] = Array.isArray(raw.rules)
    ? (raw.rules as ScopeRuleRecord[])
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
      purpose: typeof raw.purpose === "string" ? raw.purpose : "",
      guidelines: typeof raw.guidelines === "string" ? raw.guidelines : "",
      lifecycle: typeof raw.lifecycle === "string" ? raw.lifecycle : "active",
      rules,
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
      const raw = readScopeRaw(dir, id);
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
    } else if (intent === "save_basics") {
      const icon = String(form.get("icon") ?? "").trim();
      const purpose = String(form.get("purpose") ?? "").trim();
      const guidelines = String(form.get("guidelines") ?? "").trim();
      await updateScopeInDoco({
        docoDir: dir,
        scopeId,
        icon: icon || null,
        purpose: purpose || null,
        guidelines: guidelines || null,
      });
    } else if (intent === "add_deterministic_rule") {
      const raw = readScopeRaw(dir, id);
      if (!raw) return { error: "Scope not found." };
      const existing: ScopeRuleRecord[] = Array.isArray(raw.rules)
        ? (raw.rules as ScopeRuleRecord[])
        : [];
      const kind = String(form.get("kind") ?? "");
      const reason = String(form.get("reason") ?? "").trim();
      const newRule: ScopeRuleRecord = { kind };
      if (kind === "requires_edge" || kind === "forbids_edge") {
        const edge_type = String(form.get("edge_type") ?? "").trim();
        const target_node_type = String(form.get("target_node_type") ?? "").trim();
        if (!edge_type) return { error: "edge_type is required for this rule kind." };
        newRule.edge_type = edge_type;
        if (target_node_type) newRule.target_node_type = target_node_type;
      } else if (kind === "requires_field" || kind === "forbids_field") {
        const fields = form
          .getAll("fields")
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0);
        if (fields.length === 0) {
          return { error: "Pick at least one field for this rule kind." };
        }
        // Dedup while preserving the order the author picked.
        newRule.fields = [...new Set(fields)];
      } else if (kind === "mandatory_scope") {
        const scopeIds = form
          .getAll("scope_ids")
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0);
        if (scopeIds.length === 0) {
          return { error: "Pick at least one scope for mandatory_scope." };
        }
        newRule.scope_ids = [...new Set(scopeIds)];
      } else {
        return { error: `Unknown deterministic rule kind: ${kind}` };
      }
      if (reason) newRule.reason = reason;
      const next = [...existing, newRule];
      await updateScopeInDoco({ docoDir: dir, scopeId, rules: next });
    } else if (intent === "add_probabilistic_rule") {
      const raw = readScopeRaw(dir, id);
      if (!raw) return { error: "Scope not found." };
      const existing: ScopeRuleRecord[] = Array.isArray(raw.rules)
        ? (raw.rules as ScopeRuleRecord[])
        : [];
      const spec = String(form.get("spec") ?? "").trim();
      const reason = String(form.get("reason") ?? "").trim();
      if (!spec) return { error: "spec is required for probabilistic rules." };
      const newRule: ScopeRuleRecord = { kind: "probabilistic", spec };
      if (reason) newRule.reason = reason;
      const next = [...existing, newRule];
      await updateScopeInDoco({ docoDir: dir, scopeId, rules: next });
    } else if (intent === "remove_rule") {
      const indexStr = String(form.get("rule_index") ?? "");
      const index = Number.parseInt(indexStr, 10);
      if (!Number.isInteger(index) || index < 0) return { error: "Invalid rule index." };
      const raw = readScopeRaw(dir, id);
      if (!raw) return { error: "Scope not found." };
      const existing: ScopeRuleRecord[] = Array.isArray(raw.rules)
        ? (raw.rules as ScopeRuleRecord[])
        : [];
      if (index >= existing.length) return { error: "Rule index out of range." };
      const next = existing.filter((_, i) => i !== index);
      await updateScopeInDoco({ docoDir: dir, scopeId, rules: next.length === 0 ? null : next });
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
      const raw = readScopeRaw(dir, id);
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

        {/* Basics — icon + Purpose + Guidelines */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Basics</CardTitle>
            <CardDescription>
              The icon identifies the scope at a glance — it surfaces on the /scopes list, the
              /constitution tab, and on every capture footer that touches a node in this scope.
              Purpose: one sentence on why this scope exists. Guidelines: markdown the agent reads
              before authoring nodes into the scope.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-2">
              <input type="hidden" name="intent" value="save_basics" />
              <div>
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                  Icon
                </span>
                <EmojiPickerInput name="icon" defaultValue={scope.icon} />
              </div>
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                  Purpose
                </span>
                <textarea
                  name="purpose"
                  rows={2}
                  defaultValue={scope.purpose}
                  placeholder="One sentence — why this scope exists, what nodes belong here."
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                  Guidelines (markdown)
                </span>
                <textarea
                  name="guidelines"
                  rows={10}
                  defaultValue={scope.guidelines}
                  placeholder="How to author nodes in this scope. What questions they should answer, what evidence is expected, format conventions, anti-patterns."
                  className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
                />
              </label>
              <div>
                <button
                  type="submit"
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  Save basics
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
              Rules editor below (a different mechanism).
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

        {/* Rules */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Rules ({scope.rules.length})</CardTitle>
            <CardDescription>
              Predicates the engine evaluates whenever a node enters this scope. Deterministic kinds
              (requires_edge / forbids_edge / requires_field / forbids_field / mandatory_scope)
              block writes. Probabilistic kinds surface as warnings. Add and remove one at a time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scope.rules.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                No rules yet. Use the form below to add one.
              </p>
            ) : (
              <ul className="space-y-2">
                {scope.rules.map((r, i) => (
                  <li
                    key={`${r.kind}-${i}`}
                    className="flex items-baseline gap-2 rounded-md border border-border bg-card p-2 text-xs"
                  >
                    <Badge>{r.kind}</Badge>
                    <span className="flex-1 text-foreground">{describeRule(r, allScopes)}</span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_rule" />
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

            {/* Add a deterministic rule */}
            <DeterministicRuleForm allScopes={allScopes} />

            {/* Add a probabilistic rule */}
            <ProbabilisticRuleForm />
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
 * Deterministic rules block writes. Kind dictates which params are needed;
 * we show all four param blocks and let the action validate (so the form
 * works in browsers without scripting too).
 */
export function DeterministicRuleForm({
  allScopes,
}: {
  allScopes: { id: string; name: string }[];
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-input/30 p-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Add deterministic rule
      </p>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Deterministic rules block writes on violation. The engine evaluates them against the
        entity's frontmatter + the Doco's graph — no LLM involved. Pick a kind, fill in its params,
        and the rule fires every time a node enters this scope.
      </p>
      <Form method="post" className="space-y-2">
        <input type="hidden" name="intent" value="add_deterministic_rule" />
        <label className="block text-xs">
          <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
            Kind
          </span>
          <select
            name="kind"
            defaultValue="requires_edge"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
          >
            <option value="requires_edge">requires_edge — nodes must reference …</option>
            <option value="forbids_edge">forbids_edge — nodes must NOT reference …</option>
            <option value="requires_field">requires_field — frontmatter must include …</option>
            <option value="forbids_field">forbids_field — frontmatter must NOT include …</option>
            <option value="mandatory_scope">
              mandatory_scope — every node in this Doco must list …
            </option>
          </select>
        </label>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              edge_type{" "}
              <span className="text-muted-foreground">(for requires_edge / forbids_edge)</span>
            </span>
            <select
              name="edge_type"
              defaultValue=""
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">— pick an edge type —</option>
              {EDGE_TYPE_OPTIONS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              target_node_type <span className="text-muted-foreground">(optional)</span>
            </span>
            <select
              name="target_node_type"
              defaultValue=""
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">— any —</option>
              {NODE_TYPE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="block text-xs">
            <legend className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              fields{" "}
              <span className="text-muted-foreground">
                (for requires_field / forbids_field — tick one or more)
              </span>
            </legend>
            <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-input p-2 grid grid-cols-2 gap-1">
              {FIELD_OPTIONS.map((f) => (
                <label key={f} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    name="fields"
                    value={f}
                    className="size-3"
                  />
                  <span className="font-mono text-foreground">{f}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="block text-xs">
            <legend className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              scope_ids{" "}
              <span className="text-muted-foreground">
                (for mandatory_scope — tick one or more)
              </span>
            </legend>
            <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-input p-2 space-y-1">
              {allScopes.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    name="scope_ids"
                    value={s.id}
                    className="size-3"
                  />
                  <span className="font-mono text-foreground">{s.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <label className="block text-xs">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
            reason{" "}
            <span className="text-muted-foreground">(optional — shown when the rule fails)</span>
          </span>
          <input
            name="reason"
            placeholder="Why this rule exists. Surfaced to authors on violation."
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
          />
        </label>

        <div>
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            Add deterministic rule
          </button>
        </div>
      </Form>
    </div>
  );
}

/**
 * Probabilistic rules surface as warnings. The engine sends the candidate
 * node + the spec to an LLM, which returns ok/reason. No deterministic
 * matching — the spec is plain English.
 */
export function ProbabilisticRuleForm() {
  return (
    <div className="rounded-md border border-dashed border-border bg-input/30 p-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Add probabilistic rule
      </p>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Probabilistic rules surface as warnings (not blockers). The engine sends the candidate node
        and your prose spec to an LLM judge, which decides ok / not-ok and explains why. Use them
        for properties that are too fuzzy for a deterministic predicate — &ldquo;the writing is
        clear&rdquo;, &ldquo;the design rationale is concrete&rdquo;.
      </p>
      <Form method="post" className="space-y-2">
        <input type="hidden" name="intent" value="add_probabilistic_rule" />
        <label className="block text-xs">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
            spec <span className="text-muted-foreground">(plain English property)</span>
          </span>
          <textarea
            name="spec"
            rows={2}
            placeholder="Plain-English property the LLM should check (e.g. 'Decisions must reference a concrete UI element')."
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
            reason{" "}
            <span className="text-muted-foreground">(optional — shown when the rule warns)</span>
          </span>
          <input
            name="reason"
            placeholder="Why this rule exists. Surfaced to authors on a warning."
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
          />
        </label>

        <div>
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            Add probabilistic rule
          </button>
        </div>
      </Form>
    </div>
  );
}
