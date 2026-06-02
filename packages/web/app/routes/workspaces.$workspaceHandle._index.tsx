// /workspaces/:workspaceHandle — per-Workspace home. A wide two-column layout.
// The header (workspace handle + ULID, +Agent/User on desktop) spans the top.
// Left column (flexible content area once it widens past the breakpoint):
//   - Constitution (founding-charter presentation, fills the column)
//   - Latest activity feed (20 events, with per-row Doco context)
// Right column (compact sidebar):
//   - Search box (submits to /workspaces/:workspaceHandle/search)
//   - Docos in this workspace (with a +Doco button)
//   - Activity heatmap (52w)
//   - Top contributors across the workspace's Docos

import { getWorkspaceRole, updateWorkspaceConstitution, withClient } from "@doco/db";
import { entityUrl } from "@doco/shared";
import { useEffect, useState } from "react";
import { Form, Link, redirect, useFetcher } from "react-router";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Breadcrumb, workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { DocoListCard, type DocoListEntry } from "~/components/doco-list-card";
import { SiteHeader } from "~/components/site-header";
import {
  activityRowLifecycle,
  auditSummaryFallback,
  capNodeType,
  iconFromAuditOp,
  lifecycleTransitionText,
  shouldStrikeActivityTarget,
  verbFromAuditOp,
} from "~/lib/activity-feed";
import { cn } from "~/lib/cn";
import { listDocoStats } from "~/lib/doco-stats.server";
import { EMPTY_LIFECYCLE_COUNTS, type LifecycleCounts, lifecycleColor } from "~/lib/node-colors";
import { getCurrentPrincipal } from "~/lib/session.server";
import { timeAgo } from "~/lib/time-ago";
import { resolveWorkspaceByHandle } from "~/lib/workspace-helpers.server";

const FEED_LIMIT = 20;
const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;

interface WorkspaceDoco {
  docoId: string;
  handle: string;
  nodes: number;
  counts: LifecycleCounts;
  lastUpdatedAt: string | null;
}

interface TopContributor {
  userId: string;
  username: string;
  lastAt: string;
  eventCount: number;
}

interface FeedItem {
  event_id: string;
  at: string;
  byUsername: string | null;
  handle: string;
  entity_type: string;
  entity_id: string;
  summary: string | null;
  lifecycle: string | null;
  op: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const workspace = await resolveWorkspaceByHandle(params.workspaceHandle);
  if (!workspace) {
    throw new Response(`Workspace "${params.workspaceHandle}" not found.`, { status: 404 });
  }
  const me = await getCurrentPrincipal(request);
  const myRole = me ? await getWorkspaceRole(workspace.id, me.id) : null;
  const canInviteUsers = myRole === "owner";

  return withClient(async (c) => {
    // Docos owned by this workspace.
    const docoRows = (
      await c.query<{ id: string; handle: string }>(
        "SELECT id, handle FROM docos WHERE workspace_id = $1 ORDER BY handle",
        [workspace.id],
      )
    ).rows;
    const docoIds = docoRows.map((r) => String(r.id));
    const statsByDocoId = await listDocoStats(docoIds);

    const docos: WorkspaceDoco[] = docoRows
      .map((r): WorkspaceDoco => {
        const id = String(r.id);
        const stats = statsByDocoId.get(id) ?? {
          nodes: 0,
          counts: EMPTY_LIFECYCLE_COUNTS,
          lastUpdatedAt: null,
        };
        return {
          docoId: id,
          handle: String(r.handle),
          nodes: stats.nodes,
          counts: stats.counts,
          lastUpdatedAt: stats.lastUpdatedAt,
        };
      })
      .sort((a, b) => {
        if (a.lastUpdatedAt && b.lastUpdatedAt)
          return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
        if (a.lastUpdatedAt) return -1;
        if (b.lastUpdatedAt) return 1;
        return a.handle.localeCompare(b.handle);
      });

    const byDay: Record<string, number> = {};
    let topContributors: TopContributor[] = [];
    let items: FeedItem[] = [];

    if (docoIds.length > 0) {
      const since = new Date();
      since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
      const sinceIso = since.toISOString();
      const heatRows = (
        await c.query<{ day: string; n: string }>(
          `SELECT to_char(at, 'YYYY-MM-DD') AS day, COUNT(*)::text AS n
             FROM audit_events
            WHERE doco_id = ANY($1::text[]) AND at >= $2
            GROUP BY day`,
          [docoIds, sinceIso],
        )
      ).rows;
      for (const r of heatRows) byDay[r.day] = Number(r.n);

      const contributorRows = (
        await c.query<{
          user_id: string;
          user_name: string;
          last_at: Date | string;
          event_count: string;
        }>(
          `SELECT ae.by_user AS user_id,
                  COALESCE(c.github_login, c.email, c.id) AS user_name,
                  MAX(ae.at) AS last_at,
                  COUNT(*)::text AS event_count
             FROM audit_events ae
             JOIN users c ON c.id = ae.by_user
            WHERE ae.doco_id = ANY($1::text[])
            GROUP BY ae.by_user, c.github_login, c.email, c.id
            ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
            LIMIT $2`,
          [docoIds, TOP_CONTRIBUTORS_LIMIT],
        )
      ).rows;
      topContributors = contributorRows.map((r) => ({
        userId: String(r.user_id),
        username: String(r.user_name),
        lastAt:
          r.last_at instanceof Date
            ? r.last_at.toISOString()
            : new Date(String(r.last_at)).toISOString(),
        eventCount: Number(r.event_count),
      }));

      const feedRows = (
        await c.query<{
          event_id: string;
          at: Date | string;
          doco_id: string;
          entity_type: string;
          entity_id: string;
          op: string;
          before_json: Record<string, unknown> | null;
          after_json: Record<string, unknown> | null;
          user_name: string | null;
        }>(
          `SELECT a.event_id, a.at, a.doco_id, a.entity_type, a.entity_id, a.op,
                  a.before_json, a.after_json,
                  COALESCE(c.github_login, c.email, c.id) AS user_name
             FROM audit_events a
             LEFT JOIN users c ON c.id = a.by_user
            WHERE a.doco_id = ANY($1::text[])
            ORDER BY a.at DESC
            LIMIT $2`,
          [docoIds, FEED_LIMIT],
        )
      ).rows;
      const entityIds = Array.from(new Set(feedRows.map((r) => r.entity_id)));
      const entityById = new Map<string, { label: string | null; lifecycle: string | null }>();
      if (entityIds.length > 0) {
        const entityLabelRows = await c.query<{
          id: string;
          label: string | null;
          lifecycle: string | null;
        }>(
          // Post-collapse: the 9 prose node types live in `nodes`
          // (labels = first line of `prose`); policies keep their own
          // tables and `policy` column. Principals aren't shown here.
          `SELECT id, split_part(prose, E'\n', 1) AS label, lifecycle
             FROM nodes
            WHERE id = ANY($1::text[])
              AND node_type IN ('decision', 'intent', 'idea', 'rule', 'action', 'log', 'eval', 'state', 'reference')
           UNION ALL SELECT id, policy AS label, lifecycle FROM guidance_policies WHERE id = ANY($1::text[])
           UNION ALL SELECT id, policy AS label, lifecycle FROM node_authoring_policies WHERE id = ANY($1::text[])`,
          [entityIds],
        );
        for (const r of entityLabelRows.rows) {
          entityById.set(String(r.id), { label: r.label, lifecycle: r.lifecycle });
        }
      }
      const docoMap = new Map(docos.map((d) => [d.docoId, d]));
      items = feedRows.map((r) => {
        const d = docoMap.get(String(r.doco_id));
        const entity = entityById.get(String(r.entity_id));
        return {
          event_id: String(r.event_id),
          at: r.at instanceof Date ? r.at.toISOString() : new Date(String(r.at)).toISOString(),
          byUsername: r.user_name ? String(r.user_name) : null,
          handle: d?.handle ?? "?",
          entity_type: String(r.entity_type),
          entity_id: String(r.entity_id),
          summary: entity?.label ?? null,
          lifecycle: entity?.lifecycle ?? null,
          op: String(r.op),
          before: r.before_json,
          after: r.after_json,
        };
      });
    }

    return {
      workspace,
      me,
      canInviteUsers,
      canEditConstitution: canInviteUsers,
      docos,
      byDay,
      topContributors,
      items,
    };
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const workspace = await resolveWorkspaceByHandle(params.workspaceHandle);
  if (!workspace)
    throw new Response(`Workspace "${params.workspaceHandle}" not found.`, { status: 404 });
  const me = await getCurrentPrincipal(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`/workspaces/${params.workspaceHandle}`)}`);
  }
  const role = await getWorkspaceRole(workspace.id, me.id);
  if (role !== "owner") {
    return { error: "Only workspace owners can edit the constitution." };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "update-constitution") {
    await updateWorkspaceConstitution(workspace.id, String(form.get("constitution") ?? ""));
    return { ok: true };
  }
  return { error: `Unknown intent: ${intent}` };
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `${params.workspaceHandle} · Doco` }];
}

export default function WorkspaceHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const {
    workspace,
    me,
    canInviteUsers,
    canEditConstitution,
    docos,
    byDay,
    topContributors,
    items,
  } = loaderData;
  const docoItems: DocoListEntry[] = docos.map((d) => ({
    id: d.docoId,
    href: `/${d.handle}`,
    handle: d.handle,
    ownerHandle: workspace.handle,
    nodeCount: d.nodes,
    counts: d.counts,
    lastUpdatedAt: d.lastUpdatedAt,
  }));

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto w-full max-w-6xl px-6 py-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <Breadcrumb items={workspaceBreadcrumb({ workspaceSlug: workspace.handle })} />
            <h1 className="text-2xl font-semibold">{workspace.handle}</h1>
            <p className="font-mono text-xs text-muted-foreground">{workspace.id}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canInviteUsers ? (
              <Link
                to={`/workspaces/${workspace.handle}/settings`}
                className="neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold"
              >
                Settings
              </Link>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 min-[840px]:grid-cols-[minmax(0,1fr)_320px]">
          {/* Left column — the constitution gets the full available width, with
              the latest activity feed beneath it. */}
          <section className="min-w-0 space-y-4">
            <WorkspaceConstitutionCard
              workspaceHandle={workspace.handle}
              constitution={workspace.constitution}
              canEdit={canEditConstitution}
            />

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Latest activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 ? (
                  <div className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
                    No recorded activity yet across this workspace's Docos.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {items.map((it) => (
                      <WorkspaceFeedLine key={it.event_id} event={it} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Right column — search, the workspace's Docos, then the activity
              matrix and top contributors. */}
          <aside className="min-w-0 space-y-4">
            <Form
              method="get"
              action={`/workspaces/${workspace.handle}/search`}
              className="flex gap-2"
            >
              <input
                name="q"
                type="search"
                placeholder={`Search across ${docos.length} doco${docos.length === 1 ? "" : "s"}...`}
                className="w-full rounded-md px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                type="submit"
                className="neu-button rounded-md px-4 py-2.5 text-sm font-semibold text-foreground"
              >
                Search
              </button>
            </Form>

            <DocoListCard
              title="Docos in this workspace"
              headerAction={
                <Link
                  to={`/new-doco?workspace_id=${encodeURIComponent(workspace.id)}`}
                  className="neu-button rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  + Doco
                </Link>
              }
              docos={docoItems}
              empty={
                <p className="text-xs italic text-muted-foreground">
                  This workspace doesn't own any Docos yet.
                </p>
              }
            />

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Top contributors</CardTitle>
              </CardHeader>
              <CardContent>
                {topContributors.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">
                    No recorded contributions yet.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {topContributors.map((c) => (
                      <li
                        key={c.userId}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"
                      >
                        <span className="truncate" title={c.username}>
                          {c.username}
                        </span>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          {c.eventCount}
                        </span>
                        <time
                          dateTime={c.lastAt}
                          title={c.lastAt}
                          suppressHydrationWarning
                          className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
                        >
                          {timeAgo(c.lastAt)}
                        </time>
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

// Cross-Doco feed line: same shape as the dashboard's DashboardFeedLine.
// Each event carries its own Doco context (handle + cross-Doco entity URL)
// because an workspace's feed spans every Doco it owns.
function WorkspaceFeedLine({ event }: { event: FeedItem }) {
  const url = entityUrl({
    docoHandle: event.handle,
    entityType: event.entity_type,
    id: event.entity_id,
  });
  const summary = event.summary ?? auditSummaryFallback(event.entity_type, event.entity_id);
  const detail = lifecycleTransitionText(event);
  const strikeTarget = shouldStrikeActivityTarget(event);
  const lifecycleHex = lifecycleColor(activityRowLifecycle(event));
  return (
    <div className="flex items-baseline gap-3 px-5 py-3 font-mono text-xs leading-relaxed text-foreground">
      <div className="min-w-0 flex-1">
        <span>{iconFromAuditOp(event.op)} </span>
        <span className="font-semibold">
          {capNodeType(event.entity_type)} {verbFromAuditOp(event.op)}
        </span>
        <span className="text-muted-foreground">: </span>
        <Link
          to={url}
          style={{ color: lifecycleHex }}
          className={cn("hover:underline", strikeTarget && "line-through decoration-2")}
        >
          {summary}
        </Link>
        {detail ? <span className="text-muted-foreground">{detail}</span> : null}
        <span className="text-muted-foreground"> — </span>
        <Link
          to={`/${event.handle}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {event.handle}
        </Link>
        {event.byUsername ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">{event.byUsername}</span>
          </>
        ) : null}
      </div>
      <time
        dateTime={event.at}
        title={event.at}
        suppressHydrationWarning
        className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
      >
        {timeAgo(event.at)}
      </time>
    </div>
  );
}

/** Split a constitution body into paragraphs on blank lines. */
function splitConstitutionParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

const CONSTITUTION_SHARING_DISCLAIMER =
  "This constitution is always shared with agents that have access to this workspace.";

// Workspace constitution, presented like a founding charter: a centered serif
// title, a rule, and a justified body with a drop-cap opening. Owners get
// inline editing — an Edit button swaps the charter for a textarea + Save;
// the save posts via a fetcher so the page revalidates in place.
function WorkspaceConstitutionCard({
  workspaceHandle,
  constitution,
  canEdit,
}: {
  workspaceHandle: string;
  constitution: string;
  canEdit: boolean;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [editing, setEditing] = useState(false);
  // Close the editor once a save lands; the loader revalidation has already
  // refreshed the displayed text by then.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setEditing(false);
  }, [fetcher.state, fetcher.data]);

  if (editing) {
    return (
      <Card>
        <CardContent className="pt-4">
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="update-constitution" />
            <textarea
              name="constitution"
              defaultValue={constitution}
              rows={16}
              className="w-full rounded-md px-3 py-2 font-serif text-sm leading-7 text-foreground outline-none focus:border-primary"
            />
            <p className="text-[11px] italic text-muted-foreground">
              {CONSTITUTION_SHARING_DISCLAIMER}
            </p>
            {fetcher.data?.error ? (
              <p className="text-xs text-destructive">{fetcher.data.error}</p>
            ) : null}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={fetcher.state !== "idle"}
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {fetcher.state === "idle" ? "Save" : "Saving..."}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </fetcher.Form>
        </CardContent>
      </Card>
    );
  }

  const paragraphs = splitConstitutionParagraphs(constitution);

  return (
    <Card>
      <CardContent className="px-6 py-7 sm:px-10 sm:py-9">
        <article>
          <h2 className="text-center font-serif text-2xl font-semibold uppercase tracking-[0.25em] text-foreground">
            Constitution
          </h2>
          <p className="mt-1 text-center font-serif text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
            of {workspaceHandle}
          </p>
          <div className="mx-auto mt-4 h-px w-24 bg-border" />
          {paragraphs.length > 0 ? (
            <div className="mt-6 space-y-4 text-justify font-serif text-sm leading-7 text-foreground">
              {paragraphs.map((para, i) => (
                <p
                  key={para}
                  className={
                    i === 0
                      ? "first-letter:float-left first-letter:mr-2 first-letter:mt-1 first-letter:font-serif first-letter:text-5xl first-letter:font-semibold first-letter:leading-none"
                      : undefined
                  }
                >
                  {para}
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-6 text-center font-serif text-sm italic text-muted-foreground">
              No constitution has been written yet.
            </p>
          )}
          <p className="mt-7 border-t border-border pt-3 text-center text-[11px] italic text-muted-foreground">
            {CONSTITUTION_SHARING_DISCLAIMER}
          </p>
          {canEdit ? (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="neu-button rounded-md px-4 py-1.5 text-xs font-semibold text-foreground"
              >
                Edit
              </button>
            </div>
          ) : null}
        </article>
      </CardContent>
    </Card>
  );
}
