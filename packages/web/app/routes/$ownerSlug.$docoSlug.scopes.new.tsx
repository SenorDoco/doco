// Add a scope — templates + custom form. The management view (list, edit,
// delete) lives at /:owner/:doco/scopes; this page is for adding one or
// more new scopes. After each add, redirects back to the list so the
// user sees the updated state.
import { Form, Link, redirect } from "react-router";
import type { EntityId } from "@doco/shared";
import { DEFAULT_SCOPE_TEMPLATES, findScopeTemplate } from "@doco/host";
import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import {
  createIntentInDoco,
  createRuleInDoco,
  createScopeInDoco,
  reindex,
  seedScopeFromTemplate,
  updateScopeInDoco,
} from "~/lib/redeem.server";
import { listScopeDetails } from "~/lib/scope-helpers.server";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { EmojiPickerInput } from "~/components/emoji-picker-input";

const SCOPE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

// Mirror of the lists in `$ownerSlug.$docoSlug.scopes.$id.edit.tsx`. Kept
// duplicated (rather than shared) because each route owns its own
// dropdown styling; if a third place needs them, hoist into a shared
// module then.
const EDGE_TYPE_OPTIONS = [
  "serves",
  "consults",
  "enacts",
  "performed_by",
  "acts_on",
  "premise",
  "concludes",
  "has_parent",
  "has_stakeholder",
  "owned_by",
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
  "log",
  "eval",
  "reference",
  "scope",
] as const;
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
] as const;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { dir, meta, me } = await loadDocoForRead(request, ownerSlug, docoSlug);
  // Active scopes only — abandoned scopes aren't shown as parent options
  // and don't block re-installing a template with the same name (the
  // installer renames or skips depending on UX; here we just hide them).
  const allScopes = await listScopeDetails(dir);
  const scopes = allScopes.filter((s) => s.lifecycle === "active");
  const existingNames = new Set(scopes.map((s) => s.name));
  const url = new URL(request.url);
  const isOnboarding = url.searchParams.get("onboarding") === "1";
  const parentParam = url.searchParams.get("parent");
  const prefilledParent = parentParam ? scopes.find((s) => s.id === parentParam) ?? null : null;
  // Clicking "Add" on a template card navigates here with `?template=<name>`.
  // We then render a dedicated confirmation screen (explains watched vs
  // not watched, asks for the choice) instead of the picker grid — the
  // question is too important to ask inline on a cramped card.
  const pickedTemplateName = url.searchParams.get("template");
  let pickedTemplate: { name: string; icon: string; label: string; intentSummary: string } | null =
    null;
  if (pickedTemplateName) {
    const t = findScopeTemplate(pickedTemplateName);
    if (!t || existingNames.has(t.name)) {
      throw redirect(`/${ownerSlug}/${docoSlug}/scopes/new${isOnboarding ? "?onboarding=1" : ""}`);
    }
    pickedTemplate = { name: t.name, icon: t.icon, label: t.label, intentSummary: t.intentSummary };
  }
  return {
    ownerSlug,
    docoSlug,
    docoId: meta.docoId,
    displayName: meta.displayName || docoSlug,
    scopes,
    // Only offer templates that aren't already present in this Doco.
    // Once a template is added it disappears from the picker — keeps the
    // surface focused on "what's left to set up."
    templates: DEFAULT_SCOPE_TEMPLATES.filter((t) => !existingNames.has(t.name)).map((t) => ({
      name: t.name,
      label: t.label,
      icon: t.icon,
      intentSummary: t.intentSummary,
      alreadyAdded: false,
    })),
    pickedTemplate,
    isOnboarding,
    prefilledParentId: prefilledParent?.id ?? null,
    host: await loadHostConfig(),
    me,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { dir, meta, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const { docoId, ownerId } = meta;
  const createdBy = (me?.id ?? ownerId) as EntityId<"principal">;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const url = new URL(request.url);
  const isOnboarding = url.searchParams.get("onboarding") === "1";
  const afterAdd = `/${ownerSlug}/${docoSlug}/scopes${isOnboarding ? "?onboarding=1" : ""}`;

  // Per ADR-137bis every scope-creation call must declare whether this
  // scope is "watched" (a soft attention signal — contributors scan
  // against it at capture time) or not. The form sends `watched=true`
  // or `watched=false`; we reject anything else.
  const watchedRaw = String(form.get("watched") ?? "");
  if (watchedRaw !== "true" && watchedRaw !== "false") {
    return {
      error:
        "Choose whether this scope is watched (contributors should proactively look for opportunities to document into it) or not — no default per ADR-137bis.",
    };
  }
  const watched = watchedRaw === "true";

  try {
    if (intent === "add-template") {
      const tplName = String(form.get("template_name") ?? "").trim();
      const tpl = findScopeTemplate(tplName);
      if (!tpl) return { error: `Unknown template: ${tplName}` };
      const existing = await listScopeDetails(dir);
      if (existing.some((s) => s.name === tpl.name)) {
        return redirect(afterAdd);
      }
      const newId = await createScopeInDoco({
        docoDir: dir,
        docoId: docoId as EntityId<"doco">,
        name: tpl.name,
        icon: tpl.icon,
        watched,
        createdBy,
      });
      // Templates ship `intentSummary` + `rules[]`; seed both into the
      // new scope through the single entry point so the Doco-creation
      // path and this picker path stay aligned.
      await seedScopeFromTemplate({
        docoDir: dir,
        docoId: docoId as EntityId<"doco">,
        scopeId: newId,
        template: tpl,
        createdBy,
      });
    } else if (intent === "add-custom") {
      const name = String(form.get("name") ?? "").trim().toLowerCase();
      const icon = String(form.get("icon") ?? "").trim();
      const purpose = String(form.get("purpose") ?? "").trim();
      const parentId = String(form.get("parent_id") ?? "").trim() || null;
      if (!name) return { error: "Scope name is required." };
      if (!purpose) return { error: "Main intent is required." };
      if (!SCOPE_NAME_RE.test(name)) {
        return {
          error: "Name must start with a letter and use only lowercase letters, digits, hyphens, underscores. No slashes (use the parent dropdown).",
        };
      }
      const existing = await listScopeDetails(dir);
      if (existing.some((s) => s.name === name)) {
        return { error: `Scope "${name}" already exists.` };
      }
      const parentScopes: EntityId<"scope">[] = [];
      if (parentId) {
        const parent = existing.find((s) => s.id === parentId);
        if (!parent) {
          return { error: "Selected parent scope no longer exists. Refresh and pick again." };
        }
        parentScopes.push(parent.id as EntityId<"scope">);
      }
      // Optional inline first-rule. The `rule_mode` radio gates which
      // fieldset to read — "" means "no rule yet" (the scope is created
      // rule-less; the user adds rules on /scopes/<id>/edit afterwards).
      const ruleMode = String(form.get("rule_mode") ?? "").trim();
      const rules: Record<string, unknown>[] = [];
      if (ruleMode === "deterministic") {
        const ruleKind = String(form.get("rule_kind") ?? "").trim();
        const reason = String(form.get("rule_reason") ?? "").trim();
        const r: Record<string, unknown> = { kind: ruleKind };
        if (ruleKind === "requires_edge" || ruleKind === "forbids_edge") {
          const edge_type = String(form.get("rule_edge_type") ?? "").trim();
          const target_node_type = String(form.get("rule_target_node_type") ?? "").trim();
          if (!edge_type) return { error: "edge_type is required for this rule kind." };
          r.edge_type = edge_type;
          if (target_node_type) r.target_node_type = target_node_type;
        } else if (ruleKind === "requires_field" || ruleKind === "forbids_field") {
          const fields = form
            .getAll("rule_fields")
            .map((v) => String(v).trim())
            .filter((v) => v.length > 0);
          if (fields.length === 0) {
            return { error: "Pick at least one field for this rule kind." };
          }
          r.fields = [...new Set(fields)];
        } else if (ruleKind === "mandatory_scope") {
          const scopeIds = form
            .getAll("rule_scope_ids")
            .map((v) => String(v).trim())
            .filter((v) => v.length > 0);
          if (scopeIds.length === 0) {
            return { error: "Pick at least one scope for mandatory_scope." };
          }
          r.scope_ids = [...new Set(scopeIds)];
        } else {
          return { error: `Unknown deterministic rule kind: ${ruleKind}` };
        }
        if (reason) r.reason = reason;
        rules.push(r);
      } else if (ruleMode === "probabilistic") {
        const spec = String(form.get("rule_spec") ?? "").trim();
        const reason = String(form.get("rule_reason") ?? "").trim();
        if (!spec) return { error: "spec is required for probabilistic rules." };
        const r: Record<string, unknown> = { kind: "probabilistic", spec };
        if (reason) r.reason = reason;
        rules.push(r);
      }
      // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G rules are first-class
      // Rule entities now. Create the scope, then seed: the required
      // main intent textarea → an Intent referenced by the Scope's
      // single-item intent_ids list; the optional inline first-rule
      // fieldset → an authoring Rule.
      const newScopeId = await createScopeInDoco({
        docoDir: dir,
        docoId: docoId as EntityId<"doco">,
        name,
        ...(icon ? { icon } : {}),
        parentScopes,
        watched,
        createdBy,
      });
      const mainIntentId = await createIntentInDoco({
        docoId: docoId as EntityId<"doco">,
        summary: purpose,
        scopeId: newScopeId,
        createdBy,
      });
      await updateScopeInDoco({
        docoDir: dir,
        scopeId: newScopeId,
        intentIds: [mainIntentId],
      });
      for (const rule of rules) {
        const reason =
          typeof rule.reason === "string" && rule.reason.trim()
            ? rule.reason.trim()
            : `Authoring rule (${String(rule.kind ?? "?")})`;
        // Strip `reason` from the predicate; reason lives on the Rule
        // entity's `summary` instead.
        const { reason: _unused, ...predicate } = rule as { reason?: unknown; [k: string]: unknown };
        void _unused;
        await createRuleInDoco({
          docoId: docoId as EntityId<"doco">,
          kind: "authoring",
          summary: reason,
          predicate,
          scopeId: newScopeId,
          createdBy,
        });
      }
      await reindex(dir, docoId, [newScopeId, mainIntentId]);
      // After-create redirect: go straight to the merged scope page so
      // the user can refine rules right away (decision_01KRPNZY7W6CCMYNKGND67BP0B).
      return redirect(`/${ownerSlug}/${docoSlug}/scopes/${newScopeId}`);
    } else {
      return { error: `Unknown intent: ${intent}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(dir);
  return redirect(afterAdd);
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Add scope · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function AddScope({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, displayName, scopes, templates, pickedTemplate, isOnboarding, prefilledParentId, host, me } =
    loaderData;

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        {pickedTemplate ? (
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                {pickedTemplate.icon ? (
                  <span className="shrink-0 text-2xl leading-none" aria-hidden="true">
                    {pickedTemplate.icon}
                  </span>
                ) : null}
                <div>
                  <CardTitle>
                    Add the <span className="font-mono">{pickedTemplate.name}</span> scope
                  </CardTitle>
                  <CardDescription>{pickedTemplate.intentSummary}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Form method="post" className="space-y-4">
                <input type="hidden" name="intent" value="add-template" />
                <input type="hidden" name="template_name" value={pickedTemplate.name} />
                <fieldset className="rounded-md border border-border bg-input/30 p-4">
                  <legend className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Watched? *
                  </legend>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Each scope carries a <strong>watched</strong> flag — a soft
                    attention signal. When you (or an agent) capture work later,
                    a <strong>watched</strong> scope nudges you to consider
                    whether the work belongs here. <strong>Not watched</strong>{" "}
                    scopes are still available — they just don&apos;t get the
                    extra attention prompt. This is a soft signal, not
                    enforcement.
                    {isOnboarding ? (
                      <>
                        {" "}During onboarding <strong>Watched</strong> is
                        pre-selected because you&apos;re picking these scopes
                        on purpose. Flip it if you want this one to stay quiet.
                      </>
                    ) : null}
                  </p>
                  <div
                    className="flex flex-col gap-2"
                    role="radiogroup"
                    aria-label={`Watched or not watched for ${pickedTemplate.name}`}
                  >
                    <label className="flex items-start gap-2 text-xs">
                      <input
                        type="radio"
                        name="watched"
                        value="true"
                        required
                        defaultChecked={isOnboarding}
                        className="mt-0.5"
                      />
                      <span>
                        <strong>Watched</strong> — contributors should
                        proactively look for opportunities to document into
                        this scope.
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-xs">
                      <input
                        type="radio"
                        name="watched"
                        value="false"
                        required
                        defaultChecked={false}
                        className="mt-0.5"
                      />
                      <span>
                        <strong>Not watched</strong> — available, but no extra
                        prompting.
                      </span>
                    </label>
                  </div>
                </fieldset>
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                  >
                    Add scope
                  </button>
                  <Link
                    to={`/${ownerSlug}/${docoSlug}/scopes/new${isOnboarding ? "?onboarding=1" : ""}`}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    ← Back to templates
                  </Link>
                </div>
              </Form>
            </CardContent>
          </Card>
        ) : (
          <>
        {isOnboarding ? (
          <Card>
            <CardHeader>
              <CardTitle>Welcome — let&apos;s set up your first scopes</CardTitle>
              <CardDescription>
                Scopes are the topical neighborhoods this Doco will use. Every
                node belongs to one or more.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div>
                <p className="mb-1 font-semibold text-foreground">
                  What to add first
                </p>
                <p className="text-muted-foreground">
                  A solid starter set is{" "}
                  <code className="font-mono text-foreground">adrs</code>{" "}
                  (architectural choices),{" "}
                  <code className="font-mono text-foreground">user-flows</code>{" "}
                  (end-to-end journeys), plus <strong>1–2 custom scopes</strong>{" "}
                  named for <em>{displayName}</em>&apos;s actual subject areas
                  (e.g.{" "}
                  <code className="font-mono text-foreground">payments</code>,{" "}
                  <code className="font-mono text-foreground">search</code>,{" "}
                  <code className="font-mono text-foreground">content-schema</code>
                  ). More templates exist (apis, bugs, runbooks, post-mortems,
                  glossary, roadmap) — add them when the need arises, not all
                  at once.
                </p>
              </div>
              <div>
                <p className="mb-1 font-semibold text-foreground">
                  What &ldquo;watched&rdquo; means
                </p>
                <p className="text-muted-foreground">
                  Each scope carries a <strong>watched</strong> flag — a soft
                  attention signal. Watched means: when you (or an agent)
                  capture work later, this scope nudges you to consider whether
                  the work belongs here. It&apos;s a prompt, not a rule —
                  nothing blocks a capture that omits a watched scope.{" "}
                  <strong>
                    During onboarding the radio defaults to watched
                  </strong>{" "}
                  because you&apos;re picking these on purpose right now. You
                  can flip any scope&apos;s watched value any time from the
                  scope&apos;s edit page.
                </p>
              </div>
              <div>
                <p className="mb-1 font-semibold text-foreground">
                  After this page
                </p>
                <p className="text-muted-foreground">
                  Once you&apos;ve added 2–4 scopes, head back and{" "}
                  <strong>capture at least one real node into each</strong> —
                  an ADR you&apos;ve already decided, the most important user
                  flow, the contract that&apos;s in your head but not in the
                  repo. Empty scopes are documentation theater; the value is
                  what&apos;s inside them.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Common templates</CardTitle>
            <CardDescription>
              Shortcuts for documentation contexts that come up a lot. Each adds
              a scope with a seeded intent and rules so agents know how to
              author into it.
              You don&apos;t need them all — pick the ones that fit{" "}
              <em>{displayName}</em>. Clicking <strong>Add</strong> opens a
              short confirmation screen that explains the{" "}
              <strong>watched</strong> flag and asks you to choose.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {templates.map((t) => (
                <div
                  key={t.name}
                  className={
                    t.alreadyAdded
                      ? "flex items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs opacity-60"
                      : "flex items-start gap-3 rounded-md border border-border px-3 py-2 text-xs"
                  }
                >
                  {t.icon ? (
                    <span className="shrink-0 text-lg leading-none" aria-hidden="true">
                      {t.icon}
                    </span>
                  ) : null}
                  <div className="flex-1">
                    <span className="font-mono text-foreground">{t.name}</span>
                    <br />
                    <span className="text-muted-foreground">{t.intentSummary}</span>
                  </div>
                  {t.alreadyAdded ? (
                    <span className="self-center text-[10px] text-muted-foreground">
                      Added ✓
                    </span>
                  ) : (
                    // Click "Add" navigates to ?template=<name> — the
                    // confirmation screen explains watched vs not watched
                    // and asks for the choice (per ADR-137bis: no silent
                    // default). Keeps this card tight.
                    <Link
                      to={`/${ownerSlug}/${docoSlug}/scopes/new?template=${encodeURIComponent(t.name)}${isOnboarding ? "&onboarding=1" : ""}`}
                      className="self-center rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90"
                    >
                      Add
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add custom scope</CardTitle>
            <CardDescription>
              Anything that isn't a template fit. Pick a parent if this scope
              belongs under another one — the parent has to exist already (add
              it first). You can also seed one rule here; add more rules on the
              next page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="add-custom" />
              {/* Per ADR-137bis — every scope-creation call must declare
                  whether the scope is watched. No default. */}
              <fieldset className="rounded-md border border-border bg-input/30 p-3 text-xs">
                <legend className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Watched? *
                </legend>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  A <strong>watched</strong> scope tells contributors (person or
                  agent) to proactively look for opportunities to document into
                  it when capturing work. <strong>Not watched</strong> scopes
                  are still available — they just don't get the extra attention
                  prompt. This is a soft signal, not enforcement.
                </p>
                <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Watched or not watched">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="watched"
                      value="false"
                      required
                      defaultChecked={false}
                    />
                    <span>Not watched</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="watched"
                      value="true"
                      required
                      defaultChecked={isOnboarding}
                    />
                    <span>Watched — contributors should look for opportunities to document here</span>
                  </label>
                </div>
              </fieldset>
              <div className="flex flex-wrap items-start gap-3">
                <label className="block flex-1 text-xs">
                  <span className="mb-1 block font-semibold text-foreground">Name *</span>
                  <input
                    name="name"
                    required
                    pattern="[a-z][a-z0-9_-]*"
                    placeholder="payments"
                    autoFocus
                    className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    Lowercase letters, digits, hyphens, underscores. No slashes.
                  </span>
                </label>
                <div className="text-xs">
                  <span className="mb-1 block font-semibold text-foreground">
                    Icon (optional)
                  </span>
                  <EmojiPickerInput
                    name="icon"
                    triggerWidthClass="w-20"
                    triggerExtraClass="h-[30px] py-0 text-lg leading-none"
                  />
                </div>
              </div>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">
                  Main intent *
                </span>
                <textarea
                  name="purpose"
                  rows={3}
                  required
                  placeholder="What this scope is meant to make true."
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">
                  Parent scope (optional)
                </span>
                <select
                  name="parent_id"
                  defaultValue={prefilledParentId ?? ""}
                  disabled={scopes.length === 0}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
                >
                  <option value="">(no parent — root-level scope)</option>
                  {scopes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {scopes.length === 0 ? (
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    Add a scope first to make it available as a parent.
                  </span>
                ) : null}
              </label>

              {/* First rule (optional). Two separate fieldsets — deterministic
                  vs probabilistic — each with its own explanation. The user
                  picks Skip / Deterministic / Probabilistic via the radio.
                  Add more rules later on the edit page that opens after Save. */}
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  First rule (optional)
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Pick which kind of rule (if any) to seed this scope with.
                  You can leave it blank and add rules later from the edit
                  page.
                </p>

                <div className="flex flex-wrap gap-4 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="rule_mode" value="" defaultChecked />
                    <span>Skip — add rules later</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="rule_mode" value="deterministic" />
                    <span>Deterministic</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="rule_mode" value="probabilistic" />
                    <span>Probabilistic</span>
                  </label>
                </div>

                <fieldset className="rounded-md border border-dashed border-border bg-input/30 p-3">
                  <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Deterministic rule
                  </legend>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Deterministic rules block writes on violation. The engine
                    evaluates them against the entity&apos;s frontmatter + the
                    Doco&apos;s graph — no LLM involved. Pick a kind and fill
                    in its params; only this section is used if you selected
                    &ldquo;Deterministic&rdquo; above.
                  </p>
                  <label className="block text-xs">
                    <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      Kind
                    </span>
                    <select
                      name="rule_kind"
                      defaultValue="requires_edge"
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                    >
                      <option value="requires_edge">requires_edge — nodes must reference …</option>
                      <option value="forbids_edge">forbids_edge — nodes must NOT reference …</option>
                      <option value="requires_field">requires_field — frontmatter must include …</option>
                      <option value="forbids_field">forbids_field — frontmatter must NOT include …</option>
                      <option value="mandatory_scope">mandatory_scope — every node in this Doco must list …</option>
                    </select>
                  </label>

                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <label className="block text-xs">
                      <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                        edge_type{" "}
                        <span className="text-muted-foreground">(requires/forbids_edge)</span>
                      </span>
                      <select
                        name="rule_edge_type"
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
                        target_node_type{" "}
                        <span className="text-muted-foreground">(optional)</span>
                      </span>
                      <select
                        name="rule_target_node_type"
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
                          (requires/forbids_field — tick one or more)
                        </span>
                      </legend>
                      <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-input p-2 grid grid-cols-2 gap-1">
                        {FIELD_OPTIONS.map((f) => (
                          <label key={f} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              name="rule_fields"
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
                          (mandatory_scope — tick one or more)
                        </span>
                      </legend>
                      <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-input p-2 space-y-1">
                        {scopes.map((s) => (
                          <label key={s.id} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              name="rule_scope_ids"
                              value={s.id}
                              className="size-3"
                            />
                            <span className="font-mono text-foreground">{s.name}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                </fieldset>

                <fieldset className="rounded-md border border-dashed border-border bg-input/30 p-3">
                  <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Probabilistic rule
                  </legend>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Probabilistic rules surface as warnings (not blockers).
                    The engine sends the candidate node and your prose spec
                    to an LLM judge, which decides ok / not-ok and explains
                    why. Use them for properties too fuzzy for a deterministic
                    predicate. Only used if you selected
                    &ldquo;Probabilistic&rdquo; above.
                  </p>
                  <label className="block text-xs">
                    <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      spec (plain English property)
                    </span>
                    <textarea
                      name="rule_spec"
                      rows={2}
                      placeholder="Plain-English property the LLM should check (e.g. 'Decisions must reference a concrete UI element')."
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                    />
                  </label>
                </fieldset>

                <label className="block text-xs">
                  <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                    reason{" "}
                    <span className="text-muted-foreground">(optional — shown when the rule fires; applies to either kind)</span>
                  </span>
                  <input
                    name="rule_reason"
                    placeholder="Why this rule exists. Surfaced to authors on violation."
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                  />
                </label>
              </div>

              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Add scope
              </button>
            </Form>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3 pt-2 text-xs">
          {scopes.length > 0 ? (
            <Link
              to={`/${ownerSlug}/${docoSlug}/scopes${isOnboarding ? "?onboarding=1" : ""}`}
              className="rounded-md border border-border px-3 py-1.5 hover:bg-card"
            >
              ← Back to scopes ({scopes.length})
            </Link>
          ) : null}
          {isOnboarding && scopes.length > 0 ? (
            <Link
              to={`/${ownerSlug}/${docoSlug}`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Continue to Doco →
            </Link>
          ) : null}
        </div>
          </>
        )}
      </main>
    </div>
  );
}
