// Scope setup — second step after Doco creation (ADR-080) plus the
// "add more scopes anytime" page. Per ADR-081 + ADR-082:
//   - Edge-hierarchical scopes: slash-input is a convenience that auto-creates
//     parents; the slash never lands in a scope's name.
//   - Curated default templates with prefilled purpose + guidelines.
//   - Free-form custom scopes still supported alongside the templates.
//   - LLM-based suggestions when a project description is supplied
//     (ADR-082 follow-up).
import { useState } from "react";
import { Form, Link, redirect, useFetcher } from "react-router";
import type { EntityId } from "@doco/shared";
import { DEFAULT_SCOPE_TEMPLATES, findScopeTemplate } from "@doco/host";
import { docoPath, getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import {
  materializeScopeTree,
  parseScopeNamesInput,
  reindex,
  type ScopeSuggestion,
} from "~/lib/redeem.server";
import { listScopeFiles, readDocoMetadata } from "~/lib/scope-helpers.server";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const { ownerSlug, docoSlug } = params;
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = readDocoMetadata(dir);
  if (!meta) throw new Response(`Doco "${ownerSlug}/${docoSlug}" not found.`, { status: 404 });
  const existing = listScopeFiles(dir);
  const existingNames = new Set(existing.map((s) => s.name));
  const url = new URL(request.url);
  const isOnboarding = url.searchParams.get("onboarding") === "1";
  // ADR-084: ?parent=<scope_id> prefills the parent picker for child-scope creation.
  const parentParam = url.searchParams.get("parent");
  const parentScope = parentParam ? existing.find((s) => s.id === parentParam) : null;
  return {
    ownerSlug,
    docoSlug,
    docoId: meta.docoId,
    displayName: meta.displayName || docoSlug,
    description: meta.description,
    existing,
    isOnboarding,
    parentScope: parentScope ? { id: parentScope.id, name: parentScope.name } : null,
    templates: DEFAULT_SCOPE_TEMPLATES.map((t) => ({
      ...t,
      alreadyExists: existingNames.has(t.name),
    })),
    host: loadHostConfig(),
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const { ownerSlug, docoSlug } = params;
  const me = getCurrentPrincipal(request);
  // Allow anonymous access only on unclaimed Docos so the agent-create flow
  // works without a session cookie. (The owning Principal is host-bootstrap
  // for unclaimed; anyone with the URL can seed scopes during onboarding.)
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = readDocoMetadata(dir);
  if (!meta) return { error: `Doco "${ownerSlug}/${docoSlug}" not found.` };
  const { docoId, ownerId } = meta;

  const form = await request.formData();
  const skip = String(form.get("intent") ?? "") === "skip";
  const url = new URL(request.url);
  const isOnboarding = url.searchParams.get("onboarding") === "1";
  // ADR-084: when ?parent=<id> is set, all custom-input scopes get that scope
  // as their root parent. Templates ignore this (they're top-level).
  const parentParam = url.searchParams.get("parent");
  const existingForParent = listScopeFiles(dir);
  const parentScope = parentParam
    ? existingForParent.find((s) => s.id === parentParam)
    : null;

  if (skip) return redirect(`/${ownerSlug}/${docoSlug}`);

  // Templates checked by name (one form field per template).
  const checkedTemplates = DEFAULT_SCOPE_TEMPLATES.filter(
    (t) => String(form.get(`tpl:${t.name}`) ?? "") === "1",
  );

  // LLM-suggested scopes the user ticked. Each suggestion arrives with
  // its purpose + guidelines as hidden inputs so the action can write them
  // through to the YAML without a second round-trip.
  const checkedSuggestions: { name: string; purpose: string; guidelines: string }[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("sug:") || String(value) !== "1") continue;
    const name = key.slice(4);
    const purpose = String(form.get(`sug-purpose:${name}`) ?? "").trim();
    const guidelines = String(form.get(`sug-guidelines:${name}`) ?? "").trim();
    checkedSuggestions.push({ name, purpose, guidelines });
  }

  // Custom scope input — slash-paths supported.
  const customRaw = String(form.get("scopes") ?? "");
  const { valid: customPaths, invalid } = parseScopeNamesInput(customRaw);
  if (invalid.length > 0) {
    return {
      error: `Invalid scope names (lowercase letters, digits, underscores, hyphens; slash-separated): ${invalid.join(", ")}`,
    };
  }
  if (
    checkedTemplates.length === 0 &&
    checkedSuggestions.length === 0 &&
    customPaths.length === 0
  ) {
    return {
      error:
        "Pick at least one suggestion or template, add a custom scope, or click Skip to defer.",
    };
  }

  // Best-effort: attribute to the current Principal if signed in, otherwise
  // to the Doco's owner (host-bootstrap for unclaimed Docos).
  const createdBy = (me?.id ?? ownerId) as EntityId<"principal">;

  // Build a list of paths to materialize. Templates produce flat (root) paths;
  // custom input is already segmented into paths.
  const existing = listScopeFiles(dir);
  const byName = new Map<string, EntityId<"scope">>(
    existing.map((s) => [s.name, s.id as EntityId<"scope">]),
  );

  // Deduplicate templates that already exist (no-op).
  const templatePaths = checkedTemplates
    .filter((t) => !byName.has(t.name))
    .map((t) => [t.name]);
  // Suggestions: also flat root paths. Slash-named suggestions get split.
  // Suggestion-purpose/guidelines lookup keyed by leaf name.
  const suggestionLookup = new Map<
    string,
    { purpose: string; guidelines: string }
  >();
  const suggestionPaths: string[][] = [];
  for (const sug of checkedSuggestions) {
    const segments = sug.name.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const leaf = segments[segments.length - 1]!;
    if (byName.has(leaf)) continue;
    suggestionLookup.set(leaf, { purpose: sug.purpose, guidelines: sug.guidelines });
    suggestionPaths.push(segments);
  }
  // When a parent is prefilled, prepend it to every custom path so the
  // child auto-attaches under the parent. Templates + suggestions stay
  // top-level by intent.
  const customPathsWithParent =
    parentScope && customPaths.length > 0
      ? customPaths.map((p) => [parentScope.name, ...p])
      : customPaths;
  const allPaths = [...templatePaths, ...suggestionPaths, ...customPathsWithParent];

  if (allPaths.length === 0) {
    // Everything checked was already created — soft-success: just continue.
    if (isOnboarding) return redirect(`/${ownerSlug}/${docoSlug}`);
    return redirect(`/${ownerSlug}/${docoSlug}/scopes/new`);
  }

  try {
    await materializeScopeTree({
      docoDir: dir,
      docoId: docoId as EntityId<"doco">,
      paths: allPaths,
      createdBy,
      existingByName: byName,
      templateForLeaf: (leafName) => {
        const tpl = findScopeTemplate(leafName);
        if (tpl) return { purpose: tpl.purpose, guidelines: tpl.guidelines };
        return suggestionLookup.get(leafName);
      },
    });
  } catch (e) {
    return { error: `Failed to create scope: ${(e as Error).message}` };
  }
  await reindex(dir);

  if (isOnboarding) return redirect(`/${ownerSlug}/${docoSlug}`);
  return redirect(`/${ownerSlug}/${docoSlug}/scopes/new`);
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Set up scopes · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function NewScopes({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const {
    ownerSlug,
    docoSlug,
    displayName,
    description: initialDescription,
    existing,
    isOnboarding,
    parentScope,
    templates,
    host,
  } = loaderData;

  // ADR-082 follow-up: ask the LLM for project-specific scope suggestions.
  const suggestFetcher = useFetcher<{ suggestions: ScopeSuggestion[] }>();
  const [description, setDescription] = useState(initialDescription ?? "");
  const suggestions = suggestFetcher.data?.suggestions ?? [];
  const isSuggesting = suggestFetcher.state !== "idle";
  const existingNameSet = new Set(existing.map((s) => s.name));
  const visibleSuggestions = suggestions.filter(
    (s) => !existingNameSet.has(s.name.split("/").pop() ?? s.name),
  );

  function requestSuggestions(): void {
    if (!description.trim()) return;
    const body = JSON.stringify({
      description,
      existingScopeNames: existing.map((s) => s.name),
      templateNames: templates.map((t) => t.name),
    });
    suggestFetcher.submit(body, {
      method: "post",
      action: "/api/suggest-scopes",
      encType: "application/json",
    });
  }

  return (
    <div>
      <SiteHeader
        context={host.name}
        mode="host"
        docoScope={{ ownerSlug, docoSlug }}
      />
      <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
        {isOnboarding ? (
          <div className="rounded-md border border-primary bg-primary/5 px-4 py-3 text-xs">
            <strong className="text-foreground">Doco created.</strong> Pick the
            scopes you'll document in. You can skip and come back any time.
          </div>
        ) : null}
        {parentScope ? (
          <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs">
            Adding child scopes under{" "}
            <code className="font-mono">{parentScope.name}</code>. Custom-input
            scopes will be created as descendants of this scope.
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Suggest scopes for me</CardTitle>
            <CardDescription>
              Describe your project in 1-3 sentences and we'll propose
              scopes specific to it (in addition to the templates below).
              Suggestions land with prefilled purpose + guidelines so agents
              know how to author into them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. We're building a payment service for European merchants, with PCI compliance and per-country regulatory variants."
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={requestSuggestions}
              disabled={isSuggesting || description.trim().length < 5}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSuggesting ? "Thinking…" : "Suggest scopes"}
            </button>
            {suggestFetcher.data && visibleSuggestions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No suggestions returned. (LLM unavailable, or all proposals
                already exist or duplicate templates.) You can still type
                custom scopes below.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Form method="post" className="space-y-4">
          {visibleSuggestions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Suggestions for your project ({visibleSuggestions.length})
                </CardTitle>
                <CardDescription>
                  Project-specific scopes proposed by the LLM. Tick the ones
                  you want; each lands with prefilled purpose + guidelines.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {visibleSuggestions.map((s) => (
                  <label
                    key={s.name}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-xs hover:border-primary"
                  >
                    <input
                      type="checkbox"
                      name={`sug:${s.name}`}
                      value="1"
                      defaultChecked
                      className="mt-0.5"
                    />
                    <input
                      type="hidden"
                      name={`sug-purpose:${s.name}`}
                      value={s.purpose}
                    />
                    <input
                      type="hidden"
                      name={`sug-guidelines:${s.name}`}
                      value={s.guidelines}
                    />
                    <span className="flex-1">
                      <span className="font-mono text-foreground">{s.name}</span>
                      <br />
                      <span className="text-muted-foreground">{s.purpose}</span>
                      {s.reasoning ? (
                        <>
                          <br />
                          <span className="text-[10px] italic text-muted-foreground">
                            Why: {s.reasoning}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </label>
                ))}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Set up scopes · {displayName}</CardTitle>
              <CardDescription>
                Scopes are topical neighborhoods — anything you want to track
                separately. A scope can be a feature area, a country, a team,
                a customer segment, a regulatory regime, a document type, a
                migration project, anything. Pick names that make sense for
                what <em>you</em> are documenting.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">
                  What do you want to document?
                </span>
                <span className="mb-2 block text-[11px] text-muted-foreground">
                  One scope per line. Use slashes for hierarchy:{" "}
                  <code>country/france/payment</code> creates three scopes —{" "}
                  <code>country</code>, <code>france</code> (child of{" "}
                  <code>country</code>), <code>payment</code> (child of{" "}
                  <code>france</code>).
                </span>
                <textarea
                  name="scopes"
                  rows={6}
                  autoFocus
                  placeholder={
                    "checkout-flow\ncountry/france/payment\nteam/platform\nmigration/postgres-15\ngdpr-compliance"
                  }
                  className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                />
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Or start with a common template
              </CardTitle>
              <CardDescription>
                Shortcuts for documentation contexts that come up a lot. Each
                lands as a single scope with prefilled <strong>purpose</strong>{" "}
                (why it exists) and <strong>guidelines</strong> (how agents
                should author into it). Tick any number — none, some, or all.
                Custom scopes above are equally valid; templates are just a
                head start.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {templates.map((t) => (
                  <label
                    key={t.name}
                    className={
                      t.alreadyExists
                        ? "flex cursor-not-allowed items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs opacity-60"
                        : "flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-xs hover:border-primary"
                    }
                  >
                    <input
                      type="checkbox"
                      name={`tpl:${t.name}`}
                      value="1"
                      disabled={t.alreadyExists}
                      defaultChecked={false}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="font-mono text-foreground">{t.name}</span>
                      {t.alreadyExists ? (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          (already exists)
                        </span>
                      ) : null}
                      <br />
                      <span className="text-muted-foreground">{t.purpose}</span>
                    </span>
                  </label>
                ))}
              </div>
            </CardContent>
          </Card>

          {actionData?.error ? (
            <p className="text-xs text-destructive">{actionData.error}</p>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Add scopes
            </button>
            {isOnboarding ? (
              <button
                type="submit"
                name="intent"
                value="skip"
                className="rounded-md border border-border px-3 py-2 text-xs hover:bg-card"
              >
                Skip for now
              </button>
            ) : (
              <Link
                to={`/${ownerSlug}/${docoSlug}`}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Done
              </Link>
            )}
          </div>
        </Form>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Existing scopes ({existing.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {existing.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None yet. Type any names above — they can be anything.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2 text-xs">
                {existing.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-full border border-border bg-card px-2 py-0.5 font-mono"
                  >
                    {s.name}
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
