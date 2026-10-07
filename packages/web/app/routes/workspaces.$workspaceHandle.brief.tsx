// /workspaces/:workspaceHandle/brief — "What applies to…?": the workspace's
// brief, the same one an agent gets from /api/v1/brief.json (lib/brief), for
// the people of the workspace. Say what you are about to do and what it
// touches; the answer comes in four tiers across the Docos you can read, each
// item with the reason it is there, then what nobody has settled. Each brief
// is one query of the workspace in the query log, with what it served.

import { withClient } from "@doco/db";
import { getPublicBaseUrl } from "@doco/shared";
import { waitUntil } from "@vercel/functions";
import { Form, Link } from "react-router";
import { LifecycleBadge, NodeTypeBadge } from "~/components/badge";
import { workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { AGENT_INSTRUCTIONS_PATH } from "~/lib/agent-instructions";
import { BRIEF_TIERS, BRIEF_TIER_LABELS, type Brief, type BriefItem } from "~/lib/brief/brief";
import { composeBrief } from "~/lib/brief/brief.server";
import { nodeTypePlural } from "~/lib/node-colors";
import { recordQuery } from "~/lib/query-log.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { timeAgo } from "~/lib/time-ago";
import { loadWorkspaceForRead } from "~/lib/workspace-helpers.server";
import { parseBriefParams } from "./api.v1.brief[.]json";

// Embedding, reranking and the synthesis each call a model: past the
// platform's default seconds.
export const config = { maxDuration: 60 };

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const me = await getCurrentPrincipal(request);
  const { workspace, docos } = await loadWorkspaceForRead(params.workspaceHandle, me?.id ?? null);
  const ask = parseBriefParams(new URL(request.url));
  if (!ask.about && ask.touching.length === 0) {
    return { workspace, ask, brief: null as Brief | null };
  }
  const brief = await withClient((c) =>
    composeBrief(c, { docoIds: docos.map((d) => d.id), origin: getPublicBaseUrl(request) }, ask),
  );
  waitUntil(
    recordQuery(request, { workspaceId: workspace.id, docoId: null }, me?.id ?? null, {
      brief_id: brief.brief_id,
      served: brief.items.map((item) => ({ id: item.id, tier: item.tier })),
      held_back: brief.held_back,
      tokens_used: brief.tokens_used,
      steps: brief.steps,
    }),
  );
  return { workspace, ask, brief: brief as Brief | null };
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `What applies · ${params.workspaceHandle} · Doco` }];
}

const INPUT =
  "w-full rounded-md px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary";

export default function WorkspaceBrief({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { workspace, ask, brief } = loaderData;
  const tiers = BRIEF_TIERS.map((tier) => ({
    tier,
    items: brief?.items.filter((item) => item.tier === tier) ?? [],
  })).filter((t) => t.items.length > 0);
  return (
    <PageMain className="py-6 space-y-5">
      <PageHeader
        breadcrumb={workspaceBreadcrumb({
          workspaceSlug: workspace.handle,
          pageLabel: "What applies",
        })}
        title="What applies to…?"
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0 space-y-4">
          <Form method="get" className="space-y-2">
            <input
              type="search"
              name="about"
              defaultValue={ask.about}
              placeholder="What are you about to do?"
              aria-label="What you are about to do"
              className={INPUT}
            />
            <div className="flex gap-2">
              <input
                type="text"
                name="touching"
                defaultValue={ask.touching.join(", ")}
                placeholder="What it touches: paths, URLs, ids or pull requests, comma-separated"
                aria-label="What it touches"
                className={INPUT}
              />
              <button
                type="submit"
                className="neu-button shrink-0 rounded-md px-4 py-2.5 text-sm font-semibold"
              >
                Ask
              </button>
            </div>
          </Form>

          {brief?.warnings.map((warning) => (
            <div
              key={warning}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {warning}
            </div>
          ))}

          {brief ? (
            <>
              {brief.synthesis ? (
                <Card>
                  <CardContent className="p-5 text-sm leading-relaxed">
                    {brief.synthesis}
                  </CardContent>
                </Card>
              ) : null}

              {tiers.map(({ tier, items }) => (
                <Card key={tier}>
                  <CardHeader className="px-4 py-3">
                    <CardTitle className="text-sm">{BRIEF_TIER_LABELS[tier]}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ul className="divide-y divide-border">
                      {items.map((item) => (
                        <BriefItemRow key={item.id} item={item} />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}

              {brief.items.length === 0 ? (
                <p className="text-sm italic text-muted-foreground">
                  Nothing in the Docos you can read bears on this.
                </p>
              ) : null}

              {brief.gaps.length > 0 ? (
                <Card>
                  <CardHeader className="px-4 py-3">
                    <CardTitle className="text-sm">Nobody has settled</CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4">
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {brief.gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}

              <p className="text-xs text-muted-foreground">
                {brief.items.length} {brief.items.length === 1 ? "item" : "items"} ·{" "}
                {brief.held_back} held back · {brief.tokens_used} of {brief.budget} tokens ·{" "}
                {((brief.steps.total ?? 0) / 1000).toFixed(1)}s
              </p>
            </>
          ) : null}
        </section>

        <aside className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-sm">Workspace</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Link to={`/workspaces/${workspace.handle}`} className="block font-semibold">
                {workspace.handle}
              </Link>
              <Link to={`/workspaces/${workspace.handle}/integrations`} className="block text-xs">
                App integrations
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-sm">The same brief, for agents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                An agent gets this answer from <code>doco_brief</code>, or from the Doco hook before
                each prompt and file edit, across the Docos it can read.
              </p>
              <Link to={AGENT_INSTRUCTIONS_PATH} className="block text-xs">
                Instructions for agents
              </Link>
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageMain>
  );
}

/** The lines of an expanded item's prose after its first, which is the summary. */
function bodyOf(item: BriefItem): string {
  if (item.detail !== "expanded") return "";
  const lines = item.text.trim().split("\n");
  return lines.slice(1).join("\n").trim();
}

function BriefItemRow({ item }: { item: BriefItem }) {
  const body = bodyOf(item);
  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        {item.url ? (
          <a href={item.url} className="font-medium text-primary hover:underline">
            <span aria-hidden className="mr-1.5">
              <NodeTypeIcon nodeType={item.type} />
            </span>
            {item.summary || item.id}
          </a>
        ) : (
          <span className="font-medium text-foreground">{item.summary || item.id}</span>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">because {item.because}</p>
      {body ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {body}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <NodeTypeBadge nodeType={item.type}>{nodeTypePlural(item.type)}</NodeTypeBadge>
        {item.lifecycle ? <LifecycleBadge lifecycle={item.lifecycle} /> : null}
        {item.doco ? (
          <Link to={`/${item.doco}`} className="hover:underline">
            {item.doco}
          </Link>
        ) : null}
        {item.updated_at ? (
          <time dateTime={item.updated_at} title={item.updated_at} suppressHydrationWarning>
            {timeAgo(item.updated_at)}
          </time>
        ) : null}
      </div>
    </li>
  );
}
