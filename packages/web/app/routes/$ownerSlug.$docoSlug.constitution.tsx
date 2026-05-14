// /<owner>/<doco>/constitution — the Doco's Constitution scope rendered
// as a first-class tab. Three cards stack here:
//   1. Scope metadata (purpose + guidelines)
//   2. Checks — the scope's `rules` array on disk (predicates the
//      engine runs at capture time; renamed in the UI from
//      "Membership rules" to dodge collision with Rule entities)
//   3. Rules — Rule entities tagged with this scope. The constitutional
//      rules of THIS Doco — the load-bearing claims the project owner
//      authored. Project-owner-only affordances: an "Add rule" link to
//      the new-rule form, and inline Deprecate / Reactivate buttons
//      per row (lifecycle flips via the action handler below).
import { Form, Link, redirect } from "react-router";
import { parse as parseYaml } from "yaml";
import { withClient } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { canAdminDoco, loadDocoForRead, loadDocoForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { updateEntity } from "~/lib/capture.server";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { entityUrl } from "@doco/shared";

interface CheckView {
  kind: string;
  description: string;
}

interface RuleRow {
  id: string;
  summary: string;
  lifecycle: string | null;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug);
  const me = ctx.me;
  const canEdit = await canAdminDoco(ctx.meta, me?.id ?? null);
  return withClient(async (c) => {
    const scope = (
      await c.query<{ id: string; name: string; summary: string; raw_yaml: string }>(
        `SELECT id, name, summary, raw_yaml FROM scopes
          WHERE doco_id = $1 AND name = 'constitution' LIMIT 1`,
        [ctx.meta.docoId],
      )
    ).rows[0];
    if (!scope) {
      return {
        ownerSlug,
        docoSlug,
        scope: null,
        host: await loadHostConfig(),
        me,
        canEdit,
        rules: [] as CheckView[],
        constitutionalRules: [] as RuleRow[],
      };
    }
    const scopeJson = (parseYaml(scope.raw_yaml) ?? {}) as Record<string, unknown>;
    const icon = typeof scopeJson.icon === "string" ? scopeJson.icon : "";
    const purpose = typeof scopeJson.purpose === "string" ? scopeJson.purpose : "";
    const guidelines = typeof scopeJson.guidelines === "string" ? scopeJson.guidelines : "";

    // Surface the scope's `rules` array (renamed in the UI to "Checks"
    // to dodge the collision with Rule entities) as plain-English
    // descriptions.
    const rawRules = Array.isArray(scopeJson.rules)
      ? (scopeJson.rules as Record<string, unknown>[])
      : [];
    const readList = (plural: unknown, singular: unknown): string[] => {
      if (Array.isArray(plural)) return plural.filter((v): v is string => typeof v === "string");
      if (typeof singular === "string" && singular.length > 0) return [singular];
      return [];
    };
    const rules: CheckView[] = rawRules.map((r) => {
      const kind = (r.kind as string) ?? "(unknown)";
      let description = (r.reason as string) ?? "";
      if (!description) {
        if (kind === "requires_edge") {
          description = `Nodes must have an outgoing \`${r.edge_type}\` edge${r.target_node_type ? ` to a ${r.target_node_type}` : ""}.`;
        } else if (kind === "forbids_edge") {
          description = `Nodes must NOT have a \`${r.edge_type}\` edge${r.target_node_type ? ` to a ${r.target_node_type}` : ""}.`;
        } else if (kind === "requires_field") {
          const fs = readList(r.fields, r.field);
          description =
            fs.length <= 1
              ? `Nodes must declare the \`${fs[0] ?? ""}\` field.`
              : `Nodes must declare these fields: ${fs.map((f) => `\`${f}\``).join(", ")}.`;
        } else if (kind === "forbids_field") {
          const fs = readList(r.fields, r.field);
          description =
            fs.length <= 1
              ? `Nodes must NOT declare the \`${fs[0] ?? ""}\` field.`
              : `Nodes must NOT declare these fields: ${fs.map((f) => `\`${f}\``).join(", ")}.`;
        } else if (kind === "mandatory_scope") {
          const ids = readList(r.scope_ids, r.scope_id);
          description =
            ids.length <= 1
              ? `Every node in this Doco must declare scope \`${ids[0] ?? ""}\`.`
              : `Every node in this Doco must declare these scopes: ${ids
                  .map((s) => `\`${s}\``)
                  .join(", ")}.`;
        } else if (kind === "probabilistic") {
          description = `LLM-judged: ${r.spec}`;
        } else {
          description = `(${kind})`;
        }
      }
      return { kind, description };
    });

    // Rule entities tagged with this constitution scope. Listed across
    // all lifecycle stages so superseded rules stay visible alongside
    // their successors — the supersession trail is itself part of the
    // Constitution's history. Active first, then everything else.
    const constitutionalRules = (
      await c.query<RuleRow>(
        `SELECT r.id, r.summary, r.lifecycle
           FROM rules r
           JOIN edges e ON e.from_id = r.id
                       AND e.edge_type = 'in_scope_of'
                       AND e.to_id = $1
          WHERE r.doco_id = $2
          ORDER BY (CASE WHEN COALESCE(r.lifecycle, 'active') = 'active' THEN 0 ELSE 1 END),
                   r.created_at DESC`,
        [scope.id, ctx.meta.docoId],
      )
    ).rows;

    return {
      ownerSlug,
      docoSlug,
      scope: { id: scope.id, name: scope.name, icon, summary: scope.summary, purpose, guidelines },
      rules,
      constitutionalRules,
      host: await loadHostConfig(),
      me,
      canEdit,
    };
  });
}

/**
 * Action handler — lifecycle toggles on Rule entities tagged with the
 * constitution scope. The "Add rule" button isn't routed through here
 * (it navigates to /<owner>/<doco>/rules/new); deprecate / reactivate
 * are inline forms that POST back to this route.
 */
export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: "Doco not found." }, { status: 404 });
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const ruleId = String(form.get("rule_id") ?? "");
  if (!ruleId.startsWith("rule_")) {
    return Response.json({ error: "rule_id missing or malformed." }, { status: 400 });
  }
  // "deprecate" → lifecycle = "abandoned" (canonical six per ADR-100;
  // the same retirement verb the scope edit page uses).
  // "reactivate" → lifecycle = "active".
  let nextLifecycle: string;
  if (intent === "deprecate") {
    nextLifecycle = "abandoned";
  } else if (intent === "reactivate") {
    nextLifecycle = "active";
  } else {
    return Response.json({ error: `Unknown intent: ${intent}` }, { status: 400 });
  }
  const result = await updateEntity({
    docoDir: dir,
    docoId: meta.docoId,
    ownerSlug,
    docoSlug,
    nodeType: "rule",
    pluralDir: "rules",
    id: ruleId,
    patch: { lifecycle: nextLifecycle },
    allowedFields: [],
    docoHost: new URL(request.url).origin,
    actorId: me?.id ?? null,
  });
  if ("error" in result) {
    return Response.json(result, { status: result.status ?? 400 });
  }
  return redirect(`/${ownerSlug}/${docoSlug}/constitution`);
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Constitution · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function Constitution({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, scope, rules, constitutionalRules, me, canEdit } = loaderData;

  if (!scope) {
    return (
      <div>
        <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
        <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Constitution</CardTitle>
              <CardDescription>
                This Doco doesn't have a <code>constitution</code> scope yet.
                Run the constitution-seed migration to create one:
                <code className="ml-1 rounded bg-input px-1">
                  node packages/web/scripts/migrate-add-constitution-scope.mjs
                </code>
                .
              </CardDescription>
            </CardHeader>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              {scope.icon ? (
                <span className="text-2xl leading-none" aria-hidden="true">
                  {scope.icon}
                </span>
              ) : null}
              Constitution
              <Badge variant="primary">{scope.name}</Badge>
            </CardTitle>
            <CardDescription>
              Load-bearing claims that govern this Doco — invariants, authority,
              and rules other rules cite. Every Doco has one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scope.purpose ? (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Purpose
                </p>
                <p className="mt-0.5 text-sm">{scope.purpose}</p>
              </div>
            ) : null}
            {scope.guidelines ? (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Guidelines
                </p>
                <pre className="mt-0.5 whitespace-pre-wrap font-sans text-xs text-muted-foreground">
                  {scope.guidelines}
                </pre>
              </div>
            ) : null}
            <div>
              <Link
                to={entityUrl({ ownerSlug, docoSlug, nodeType: "scope", id: scope.id })}
                className="text-xs text-primary hover:underline"
              >
                Edit scope (purpose / guidelines / rules) →
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Checks ({rules.length})
            </CardTitle>
            <CardDescription>
              Predicates the engine evaluates on every capture into this
              scope. Deterministic checks block writes; probabilistic
              ones surface as warnings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rules.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No checks yet. Edit the scope to add some
                (mandatory-scope, requires-field, requires-edge, etc.).
              </p>
            ) : (
              <ul className="space-y-2">
                {rules.map((r, i) => (
                  <li
                    key={`${r.kind}-${i}`}
                    className="flex items-baseline gap-2 rounded-md border border-border p-2 text-xs"
                  >
                    <Badge>{r.kind}</Badge>
                    <span className="text-foreground">{r.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between gap-3">
              <span>Rules ({constitutionalRules.length})</span>
              {canEdit ? (
                <Link
                  to={`/${ownerSlug}/${docoSlug}/rules/new?scope=constitution`}
                  className="rounded-md border border-border bg-input px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-card"
                >
                  + Add rule
                </Link>
              ) : null}
            </CardTitle>
            <CardDescription>
              Rule entities the project owner has tagged into this scope
              — the load-bearing claims this Doco is held to. Deprecated
              and superseded entries are kept so the trail of "what we
              used to say" stays visible.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {constitutionalRules.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No Rule entities tagged with <code>constitution</code> yet.
                {canEdit ? (
                  <>
                    {" "}
                    <Link
                      to={`/${ownerSlug}/${docoSlug}/rules/new?scope=constitution`}
                      className="text-primary hover:underline"
                    >
                      Add the first one →
                    </Link>
                  </>
                ) : (
                  <>
                    {" "}Capture one with{" "}
                    <code>doco capture rule --scope constitution …</code>{" "}
                    and it'll show up here.
                  </>
                )}
              </p>
            ) : (
              <ul className="space-y-2 text-xs">
                {constitutionalRules.map((r) => {
                  const isActive = (r.lifecycle ?? "active") === "active";
                  return (
                    <li key={r.id} className="flex items-baseline gap-2">
                      <Link
                        to={entityUrl({
                          ownerSlug,
                          docoSlug,
                          nodeType: "rule",
                          id: r.id,
                        })}
                        className="flex-1 text-primary hover:underline"
                      >
                        {r.summary}
                      </Link>
                      {!isActive ? (
                        <Badge>{r.lifecycle}</Badge>
                      ) : null}
                      {canEdit ? (
                        <Form method="post" className="m-0">
                          <input type="hidden" name="rule_id" value={r.id} />
                          <input
                            type="hidden"
                            name="intent"
                            value={isActive ? "deprecate" : "reactivate"}
                          />
                          <button
                            type="submit"
                            className="rounded border border-border bg-input px-2 py-0.5 text-[10px] font-semibold text-muted-foreground hover:bg-card hover:text-foreground"
                          >
                            {isActive ? "Deprecate" : "Reactivate"}
                          </button>
                        </Form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
