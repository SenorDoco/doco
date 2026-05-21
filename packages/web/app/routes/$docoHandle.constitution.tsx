import { withClient } from "@doco/db";
import { Link } from "react-router";
import { parse as parseYaml } from "yaml";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { SiteHeader } from "~/components/site-header";
import {
  AGENT_EXPOSURE_NOTE,
  GUIDANCE_ARTICLE_EXPLAINER,
  NODE_AUTHORING_ARTICLE_EXPLAINER,
} from "~/lib/constitution-copy";
import {
  canEditConstitution,
  loadDocoForRead,
  normalizeDocoParams,
} from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";

type ArticleKind = "deterministic" | "probabilistic";

interface ArticleRow {
  id: string;
  summary: string;
  lifecycle: string | null;
  created_at: Date | string | null;
  body_md: string | null;
  raw_yaml: string;
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
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForRead(request, handle);
  const [guidanceRows, nodeAuthoringRows] = await withClient(async (c) => {
    const guidance = await c.query<ArticleRow>(
      `SELECT id, summary, lifecycle, created_at, body_md, raw_yaml
         FROM guidance_articles
        WHERE doco_id = $1
        ORDER BY created_at DESC`,
      [ctx.meta.docoId],
    );
    const nodeAuthoring = await c.query<ArticleRow>(
      `SELECT id, summary, lifecycle, created_at, body_md, raw_yaml
         FROM node_authoring_articles
        WHERE doco_id = $1
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

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `Constitution · ${params.docoId} · Doco` }];
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
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Constitution" })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">Constitution</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rules that govern how nodes get added to this doco. {AGENT_EXPOSURE_NOTE}
          </p>
        </header>

        <ArticleSection
          title="Guidance articles"
          nodeType="guidance_article"
          description={GUIDANCE_ARTICLE_EXPLAINER}
          addHref={canEdit ? `/${handle}/constitution/guidance/new` : null}
          items={guidanceArticles}
          handle={handle}
          empty="No guidance articles yet."
        />

        <ArticleSection
          title="Node authoring articles"
          nodeType="node_authoring_article"
          description={NODE_AUTHORING_ARTICLE_EXPLAINER}
          addHref={canEdit ? `/${handle}/constitution/node-authoring/new` : null}
          items={nodeAuthoringArticles}
          handle={handle}
          empty="No node authoring articles yet."
        />
      </main>
    </div>
  );
}

function ArticleSection({
  title,
  nodeType,
  description,
  addHref,
  items,
  handle,
  empty,
}: {
  title: string;
  nodeType: "guidance_article" | "node_authoring_article";
  description: string;
  addHref: string | null;
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
              <NodeTypeIcon nodeType={nodeType} className="h-4 w-4" />
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
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
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
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/${handle}/${nodeType}/${item.id}`}
                      className="font-medium leading-snug hover:text-primary"
                    >
                      {item.summary}
                    </Link>
                    {"evaluationKind" in item ? (
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                        <span>{item.evaluationKind}</span>
                        <span>{item.predicateKind}</span>
                      </div>
                    ) : null}
                    {item.body ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {item.body}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {item.lifecycle ?? "active"}
                  </span>
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
  const fm = readFrontmatter(row.raw_yaml);
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

function readFrontmatter(rawYaml: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(rawYaml);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
