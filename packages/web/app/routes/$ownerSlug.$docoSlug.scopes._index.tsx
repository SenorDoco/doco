import { withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
// Scope management — slim list of scopes with row-level navigation.
//
// Each row shows just: name, parents (if any), short description, node
// count, and watched state. Clicking the row opens the entity-detail page.
// Purpose + guidelines + rules live on the detail page, not inline.
// Deletion is intentionally NOT here — it lives only in the Danger Zone
// at the bottom of /scopes/<id>/edit, so the act of destroying a scope
// requires opening its edit page first.
import { Link, redirect } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { listScopeDetails } from "~/lib/scope-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { dir, meta, me } = await loadDocoForRead(request, ownerSlug, docoSlug);
  const scopes = await listScopeDetails(dir);
  const url = new URL(request.url);
  const isOnboarding = url.searchParams.get("onboarding") === "1";
  if (scopes.length === 0) {
    throw redirect(`/${ownerSlug}/${docoSlug}/scopes/new${isOnboarding ? "?onboarding=1" : ""}`);
  }

  const memberCount = new Map<string, number>();
  try {
    await withClient(async (c) => {
      const r = await c.query<{ scope_id: string; n: string }>(
        `SELECT to_id AS scope_id, COUNT(*)::text AS n
           FROM edges
          WHERE edge_type = 'in_scope_of'
            AND from_node_type != 'scope'
            AND doco_id = $1
          GROUP BY to_id`,
        [meta.docoId],
      );
      for (const row of r.rows) memberCount.set(row.scope_id, Number(row.n));
    });
  } catch {
    /* PG unreachable — counts default to 0 */
  }

  return {
    ownerSlug,
    docoSlug,
    displayName: meta.displayName || docoSlug,
    scopes: scopes.map((s) => ({
      ...s,
      member_count: memberCount.get(s.id) ?? 0,
    })),
    isOnboarding,
    host: await loadHostConfig(),
    me,
  };
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Scopes · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

/** Truncate a string to ~120 chars on a word boundary; "…" suffix if cut. */
function shortDescription(text: string, cap = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  const cut = trimmed.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > cap / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

export default function ScopesIndex({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, displayName, scopes, isOnboarding, host, me } = loaderData;
  type ScopeRow = (typeof scopes)[number];
  const isAbandonedScope = (scope: ScopeRow) =>
    scope.lifecycle !== "active" && scope.lifecycle !== "proposed";
  const sortedScopes = [...scopes].sort((a, b) => {
    if (a.name === "global" && b.name !== "global") return -1;
    if (b.name === "global" && a.name !== "global") return 1;
    return 0;
  });
  const activeScopes = sortedScopes.filter((scope) => !isAbandonedScope(scope));
  const abandonedScopes = sortedScopes.filter(isAbandonedScope);

  const renderScopeRow = (s: ScopeRow) => {
    const parents = s.parent_ids
      .map((pid) => scopes.find((x) => x.id === pid)?.name)
      .filter(Boolean) as string[];
    const description = shortDescription(s.short_description);
    const isAbandoned = isAbandonedScope(s);
    const isGlobal = s.name === "global";
    return (
      <li key={s.id}>
        <Link
          to={entityUrl({ ownerSlug, docoSlug, nodeType: "scope", id: s.id })}
          className={
            isAbandoned
              ? "flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs text-inherit no-underline opacity-50 transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
              : "flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs text-inherit no-underline transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
          }
        >
          <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-0 sm:flex-1">
            {s.icon ? (
              <span className="shrink-0 text-lg leading-none" aria-hidden="true">
                {s.icon}
              </span>
            ) : (
              <span className="shrink-0 w-5" aria-hidden="true" />
            )}
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
              <span
                className={
                  isAbandoned
                    ? "font-mono text-sm text-foreground line-through"
                    : "font-mono text-sm text-foreground"
                }
              >
                {s.name}
              </span>
              {isGlobal ? (
                <span className="text-[10px] text-muted-foreground">(the doco's constitution)</span>
              ) : null}
              {isAbandoned ? (
                <span className="rounded-md border border-border bg-input px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  abandoned
                </span>
              ) : null}
              {parents.length > 0 ? (
                <span className="text-[10px] text-muted-foreground">
                  under {parents.join(" / ")}
                </span>
              ) : null}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
            <span className="whitespace-nowrap text-[10px] text-muted-foreground">
              {s.member_count} {s.member_count === 1 ? "node" : "nodes"}
            </span>
            <span
              className={
                s.is_watched
                  ? "inline-flex items-center gap-1 rounded-md border border-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                  : "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
              }
              title={
                s.is_watched
                  ? "Watched — contributors look for opportunities to document here"
                  : "Not watched"
              }
            >
              <span aria-hidden="true">{s.is_watched ? "👁" : "·"}</span>
              {s.is_watched ? "Watched" : "Not watched"}
            </span>
          </div>
          {description ? (
            <p className="basis-full truncate pl-8 text-muted-foreground">{description}</p>
          ) : (
            <p className="basis-full pl-8 text-[11px] italic text-muted-foreground">
              No description.
            </p>
          )}
        </Link>
      </li>
    );
  };

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>
                  Scopes · {displayName} ({scopes.length})
                </CardTitle>
                <CardDescription>Topical neighborhoods every node belongs to.</CardDescription>
              </div>
              <Link
                to={`/${ownerSlug}/${docoSlug}/scopes/new${isOnboarding ? "?onboarding=1" : ""}`}
                className="self-center whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                + Add scope
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {/* Per decision_01KRPNZY7W6CCMYNKGND67BP0B the Global scope
                  sorts to the top of the list and renders with the
                  caption "the doco's constitution" next to its name. */}
              {activeScopes.map(renderScopeRow)}
              {abandonedScopes.length > 0 ? (
                <li className="bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
                  Abandoned
                </li>
              ) : null}
              {abandonedScopes.map(renderScopeRow)}
            </ul>
          </CardContent>
        </Card>

        {isOnboarding ? (
          <div className="flex items-center gap-3 pt-2 text-xs">
            <Link
              to={`/${ownerSlug}/${docoSlug}`}
              className="rounded-md border border-border px-3 py-1.5 hover:bg-card"
            >
              Continue to Doco →
            </Link>
          </div>
        ) : null}
      </main>
    </div>
  );
}
