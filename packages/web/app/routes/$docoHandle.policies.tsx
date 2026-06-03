import { withClient } from "@doco/db";
import { Link } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { PageHeader } from "~/components/page-header";
import { SiteHeader } from "~/components/site-header";
import { canEditPolicies, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import {
  AGENT_EXPOSURE_NOTE,
  GUIDANCE_POLICY_EXPLAINER,
  NODE_AUTHORING_POLICY_EXPLAINER,
  policyFullText,
} from "~/lib/policy-copy";

type ArticleKind = "deterministic" | "probabilistic";

interface ArticleRow {
  id: string;
  policy: string;
  lifecycle: string | null;
  created_at: Date | string | null;
  body_md: string | null;
  data: Record<string, unknown> | null;
}

interface GuidanceArticleItem {
  id: string;
  policy: string;
  lifecycle: string | null;
  createdAt: string | null;
  body: string;
}

interface NodeAuthoringArticleItem extends GuidanceArticleItem {
  evaluationKind: ArticleKind;
  predicateKind: string;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const [guidanceRows, nodeAuthoringRows] = await withClient(async (c) => {
    const guidance = await c.query<ArticleRow>(
      `SELECT id, policy, lifecycle, created_at, body_md, data
         FROM guidance_policies
        WHERE doco_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'
        ORDER BY created_at DESC`,
      [ctx.meta.docoId],
    );
    const nodeAuthoring = await c.query<ArticleRow>(
      `SELECT id, policy, lifecycle, created_at, body_md, data
         FROM node_authoring_policies
        WHERE doco_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'
        ORDER BY created_at DESC`,
      [ctx.meta.docoId],
    );
    return [guidance.rows, nodeAuthoring.rows] as const;
  });

  return {
    ownerSlug,
    docoSlug,
    handle,
    me: ctx.me,
    host: await loadHostConfig(),
    canEdit: await canEditPolicies(ctx.meta, ctx.me?.id ?? null),
    guidanceArticles: guidanceRows.map(toGuidanceArticle),
    nodeAuthoringArticles: nodeAuthoringRows.map(toNodeAuthoringArticle),
  };
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Policies · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function Policies({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, me, canEdit, guidanceArticles, nodeAuthoringArticles } =
    loaderData;

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <PageHeader
          breadcrumb={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Policies" })}
          title="Policies"
        >
          <p className="text-sm text-muted-foreground">
            Rules that govern how nodes get added to this doco. {AGENT_EXPOSURE_NOTE}
          </p>
        </PageHeader>

        <ArticleSection
          title="Guidance policies"
          entityType="guidance_policy"
          description={GUIDANCE_POLICY_EXPLAINER}
          addHref={canEdit ? `/${handle}/policies/guidance/new` : null}
          editHrefBase={canEdit ? `/${handle}/policies/guidance` : null}
          items={guidanceArticles}
          handle={handle}
          empty="No guidance policies yet."
        />

        <ArticleSection
          title="Node-authoring policies"
          entityType="node_authoring_policy"
          description={NODE_AUTHORING_POLICY_EXPLAINER}
          addHref={canEdit ? `/${handle}/policies/node-authoring/new` : null}
          editHrefBase={canEdit ? `/${handle}/policies/node-authoring` : null}
          items={nodeAuthoringArticles}
          handle={handle}
          empty="No node-authoring policies yet."
        />
      </main>
    </div>
  );
}

function ArticleSection({
  title,
  entityType,
  description,
  addHref,
  editHrefBase,
  items,
  handle,
  empty,
}: {
  title: string;
  entityType: "guidance_policy" | "node_authoring_policy";
  description: string;
  addHref: string | null;
  editHrefBase: string | null;
  items: (GuidanceArticleItem | NodeAuthoringArticleItem)[];
  handle: string;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <NodeTypeIcon entityType={entityType} className="h-4 w-4" />
              <span>{title}</span>
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {items.length}
              </span>
            </CardTitle>
            <CardDescription className="leading-5">{description}</CardDescription>
          </div>
          {addHref ? (
            <Link
              to={addHref}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold"
            >
              + Add
            </Link>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <Link
                    to={`/${handle}/${entityType}/${item.id}`}
                    className="min-w-0 flex-1 hover:text-primary"
                  >
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {policyFullText({ policy: item.policy, body: item.body })}
                    </p>
                    {"evaluationKind" in item ? (
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                        <span>{item.evaluationKind}</span>
                        <span>{item.predicateKind}</span>
                      </div>
                    ) : null}
                  </Link>
                  <span className="neu-surface shrink-0 rounded px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {item.lifecycle ?? "active"}
                  </span>
                  {editHrefBase ? (
                    <Link
                      to={`${editHrefBase}/${item.id}/edit`}
                      className="neu-button shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-foreground"
                    >
                      Modify
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function toGuidanceArticle(row: ArticleRow): GuidanceArticleItem {
  return {
    id: row.id,
    policy: row.policy,
    lifecycle: row.lifecycle,
    createdAt: toIso(row.created_at),
    body: row.body_md ?? "",
  };
}

function toNodeAuthoringArticle(row: ArticleRow): NodeAuthoringArticleItem {
  const fm = row.data ?? {};
  const predicate =
    fm.predicate && typeof fm.predicate === "object"
      ? (fm.predicate as Record<string, unknown>)
      : {};
  return {
    ...toGuidanceArticle(row),
    evaluationKind: fm.evaluation_kind === "probabilistic" ? "probabilistic" : "deterministic",
    predicateKind: typeof predicate.kind === "string" ? predicate.kind : "unknown",
  };
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
