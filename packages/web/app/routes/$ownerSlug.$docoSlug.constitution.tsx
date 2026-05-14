// /<owner>/<doco>/constitution — the Doco's Constitution scope rendered
// as a first-class tab. Lists the scope's purpose + guidelines + every
// node tagged with `constitution`, grouped by node type. Surfaces the
// deterministic `rules` so the contract is visible.
import { Link } from "react-router";
import { openDocoDb } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { entityUrl } from "@doco/shared";

interface ConstitutionMember {
  id: string;
  node_type: string;
  summary: string;
  lifecycle: string | null;
}

interface MembershipRuleView {
  kind: string;
  description: string;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { me } = await loadDocoForRead(request, ownerSlug, docoSlug);
  const db = openDocoDb(ownerSlug, docoSlug);
  try {
    // Find the Constitution scope.
    const scope = db
      .prepare(
        "SELECT id, name, summary, raw_json FROM scope WHERE name = 'constitution' LIMIT 1",
      )
      .get() as { id: string; name: string; summary: string; raw_json: string } | undefined;
    if (!scope) {
      return {
        ownerSlug,
        docoSlug,
        scope: null,
        host: await loadHostConfig(),
        me,
        memberCount: 0,
        membersByType: {},
        rules: [],
      };
    }
    const scopeJson = JSON.parse(scope.raw_json) as Record<string, unknown>;
    const icon = typeof scopeJson.icon === "string" ? scopeJson.icon : "";
    const purpose = typeof scopeJson.purpose === "string" ? scopeJson.purpose : "";
    const guidelines = typeof scopeJson.guidelines === "string" ? scopeJson.guidelines : "";

    // Pull every node tagged with the Constitution.
    const memberTypes = [
      "rule",
      "decision",
      "intent",
      "action",
      "reasoning",
      "idea",
      "reference",
      "eval",
    ] as const;
    const membersByType: Record<string, ConstitutionMember[]> = {};
    for (const t of memberTypes) {
      try {
        const rows = db
          .prepare(
            `SELECT t.id, t.summary, t.lifecycle
             FROM ${t} t
             JOIN edges e ON e.from_id = t.id AND e.edge_type = 'in_scope_of' AND e.to_id = ?
             ORDER BY t.created_at DESC LIMIT 100`,
          )
          .all(scope.id) as Record<string, string | null>[];
        const mapped = rows.map((r) => ({
          id: r.id as string,
          node_type: t,
          summary: (r.summary as string) ?? "",
          lifecycle: r.lifecycle ?? null,
        }));
        if (mapped.length > 0) membersByType[t] = mapped;
      } catch {
        /* table missing — skip */
      }
    }
    const memberCount = Object.values(membersByType).reduce((n, arr) => n + arr.length, 0);

    // Surface the membership rules as plain-English descriptions.
    const rawRules = Array.isArray(scopeJson.rules)
      ? (scopeJson.rules as Record<string, unknown>[])
      : [];
    const readList = (plural: unknown, singular: unknown): string[] => {
      if (Array.isArray(plural)) return plural.filter((v): v is string => typeof v === "string");
      if (typeof singular === "string" && singular.length > 0) return [singular];
      return [];
    };
    const rules: MembershipRuleView[] = rawRules.map((r) => {
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

    return {
      ownerSlug,
      docoSlug,
      scope: { id: scope.id, name: scope.name, icon, summary: scope.summary, purpose, guidelines },
      memberCount,
      membersByType,
      rules,
      host: await loadHostConfig(),
      me,
    };
  } finally {
    db.close();
  }
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Constitution · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function Constitution({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, scope, memberCount, membersByType, rules, host, me } = loaderData;

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
              Rules ({rules.length})
            </CardTitle>
            <CardDescription>
              Predicates the engine evaluates on every capture. Deterministic
              rules block writes; probabilistic ones surface as warnings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rules.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No rules yet. The seed migration adds one — "Constitution nodes
                must reference at least one Intent" — but you can edit the
                scope to add more (mandatory-scope, requires-field, etc.).
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
            <CardTitle className="text-sm">
              Members ({memberCount})
            </CardTitle>
            <CardDescription>
              Every node tagged with the Constitution.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {memberCount === 0 ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">
                No nodes yet. Add load-bearing Rules / Decisions / Intents here.
              </p>
            ) : (
              <ul className="divide-y divide-border text-xs">
                {Object.entries(membersByType).flatMap(([t, rows]) =>
                  rows.map((m) => (
                    <li key={m.id} className="flex items-baseline gap-3 px-5 py-2">
                      <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {t}
                      </span>
                      <span className="flex-1 truncate text-foreground">{m.summary}</span>
                      <Link
                        to={entityUrl({
                          ownerSlug,
                          docoSlug,
                          nodeType: t,
                          id: m.id,
                        })}
                        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold hover:bg-input"
                      >
                        View
                      </Link>
                    </li>
                  )),
                )}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
