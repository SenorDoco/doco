import { withClient } from "@doco/db";
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { SiteHeader } from "~/components/site-header";
import {
  AGENT_EXPOSURE_NOTE,
  GUIDANCE_PRIMITIVE_EXPLAINER,
  NEURON_AUTHORING_PRIMITIVE_EXPLAINER,
  primitiveFullText,
} from "~/lib/constitution-copy";
import { canEditConstitution, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";

type ArticleKind = "deterministic" | "probabilistic";

interface ArticleRow {
  id: string;
  summary: string;
  lifecycle: string | null;
  created_at: Date | string | null;
  body_md: string | null;
  data: Record<string, unknown> | null;
}

interface GuidanceArticleItem {
  id: string;
  summary: string;
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
      `SELECT id, summary, lifecycle, created_at, body_md, data
         FROM guidance_primitives
        WHERE doco_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'
        ORDER BY created_at DESC`,
      [ctx.meta.docoId],
    );
    const nodeAuthoring = await c.query<ArticleRow>(
      `SELECT id, summary, lifecycle, created_at, body_md, data
         FROM neuron_authoring_primitives
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
    canEdit: await canEditConstitution(ctx.meta, ctx.me?.id ?? null),
    guidanceArticles: guidanceRows.map(toGuidanceArticle),
    nodeAuthoringArticles: nodeAuthoringRows.map(toNodeAuthoringArticle),
  };
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [
    { title: `Primitives · ${params.docoHandle ?? params.docoId ?? ""} · Doco` },
  ];
}

export default function Constitution({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, me, canEdit, guidanceArticles, nodeAuthoringArticles } =
    loaderData;

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={docoBreadcrumb({
              ownerSlug,
              handle,
              pageLabel: "Primitives",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">Primitives</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rules that govern how neurons get added to this doco. {AGENT_EXPOSURE_NOTE}
          </p>
        </header>

        <ArticleSection
          title="Guidance primitives"
          entityType="guidance_primitive"
          description={GUIDANCE_PRIMITIVE_EXPLAINER}
          addHref={canEdit ? `/${handle}/constitution/guidance/new` : null}
          editHrefBase={canEdit ? `/${handle}/constitution/guidance` : null}
          items={guidanceArticles}
          handle={handle}
          empty="No guidance primitives yet."
        />

        <ArticleSection
          title="Neuron-authoring primitives"
          entityType="neuron_authoring_primitive"
          description={NEURON_AUTHORING_PRIMITIVE_EXPLAINER}
          addHref={canEdit ? `/${handle}/constitution/neuron-authoring/new` : null}
          editHrefBase={canEdit ? `/${handle}/constitution/neuron-authoring` : null}
          items={nodeAuthoringArticles}
          handle={handle}
          empty="No neuron-authoring primitives yet."
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
  entityType: "guidance_primitive" | "neuron_authoring_primitive";
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
              <NeuronTypeIcon entityType={entityType} className="h-4 w-4" />
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
              className="neo-raised-primary shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold"
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
                      {primitiveFullText({ summary: item.summary, body: item.body })}
                    </p>
                    {"evaluationKind" in item ? (
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                        <span>{item.evaluationKind}</span>
                        <span>{item.predicateKind}</span>
                      </div>
                    ) : null}
                  </Link>
                  <span className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {item.lifecycle ?? "active"}
                  </span>
                  {editHrefBase ? (
                    <Link
                      to={`${editHrefBase}/${item.id}/edit`}
                      className="neo-raised-sm shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-foreground"
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
    summary: row.summary,
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
