import { withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
// Scope management — slim list of scopes with row-level navigation.
//
// Each row shows just: name, parents (if any), node count, and watched state.
// Clicking the row opens the entity-detail page.
// Rules live on the detail page, not inline.
// Deletion is intentionally NOT here — it lives only in the Danger Zone
// at the bottom of /scopes/<id>/edit, so the act of destroying a scope
// requires opening its edit page first.
import { Link, redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { listScopeDetails } from "~/lib/scope-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { dir, meta, me } = await loadDocoForRead(request, handle);
  const scopes = await listScopeDetails(dir, { includePrimaryIntent: true });
  const url = new URL(request.url);
  const isOnboarding = url.searchParams.get("onboarding") === "1";
  if (scopes.length === 0) {
    throw redirect(`/${handle}/scopes/new${isOnboarding ? "?onboarding=1" : ""}`);
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
    handle,
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

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `Scopes · ${params.docoId} · Doco` }];
}

export default function ScopesIndex({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, displayName, scopes, isOnboarding, host, me } = loaderData;
  type ScopeRow = (typeof scopes)[number];
  const isAbandonedScope = (scope: ScopeRow) =>
    scope.lifecycle !== "active" && scope.lifecycle !== "proposed";
  // Global sorts first. Accept both `#global` (canonical) and the
  // post-rename bare `global` until every Doco has been migrated.
  const isGlobalName = (n: string) => n === "#global" || n === "global";
  const sortedScopes = [...scopes].sort((a, b) => {
    if (isGlobalName(a.name) && !isGlobalName(b.name)) return -1;
    if (isGlobalName(b.name) && !isGlobalName(a.name)) return 1;
    return 0;
  });
  const activeScopes = sortedScopes.filter((scope) => !isAbandonedScope(scope));
  const abandonedScopes = sortedScopes.filter(isAbandonedScope);

  const renderScopeRow = (s: ScopeRow) => {
    const parents = s.parent_ids
      .map((pid) => scopes.find((x) => x.id === pid)?.name)
      .filter(Boolean) as string[];
    const isAbandoned = isAbandonedScope(s);
    const isGlobal = isGlobalName(s.name);
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
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-2">
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
                  <span className="text-[10px] text-muted-foreground">
                    (your doco's constitution)
                  </span>
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
              {s.primary_intent ? (
                <div className="min-w-0 break-words text-[11px] leading-snug text-muted-foreground">
                  {s.primary_intent.summary}
                </div>
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
        </Link>
      </li>
    );
  };

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>
                  Scopes · {displayName} ({scopes.length})
                </CardTitle>
              </div>
              <Link
                to={`/${handle}/scopes/new${isOnboarding ? "?onboarding=1" : ""}`}
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
                  caption "your doco's constitution" next to its name. */}
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
              to={`/${handle}`}
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
