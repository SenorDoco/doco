// /orgs/:orgHandle/constitution — org-level constitution landing.
//
// Mirrors /:docoHandle/constitution. Articles authored here apply to
// every doco the org owns. The edit gate is org-owner.

import { getOrgRole, withClient } from "@doco/db";
import { Link } from "react-router";
import { parse as parseYaml } from "yaml";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { SiteHeader } from "~/components/site-header";
import {
  AGENT_EXPOSURE_NOTE,
  GUIDANCE_ARTICLE_EXPLAINER,
  NODE_AUTHORING_ARTICLE_EXPLAINER,
  articleFullText,
} from "~/lib/constitution-copy";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

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

interface OrgRow {
  id: string;
  slug: string;
  name: string;
}

async function resolveOrgByHandle(orgHandle: string): Promise<OrgRow | null> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM organizations
        WHERE handle = $1 OR slug = $1
        LIMIT 1`,
      [orgHandle],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    if (!row) return null;
    return { id: String(row.id), slug: String(row.slug), name: String(row.name) };
  });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { orgHandle: string };
}) {
  const org = await resolveOrgByHandle(params.orgHandle);
  if (!org) {
    throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  const role = me ? await getOrgRole(org.id, me.id) : null;
  const canEdit = role === "owner";

  const [guidanceRows, nodeAuthoringRows] = await withClient(async (c) => {
    const guidance = await c.query<ArticleRow>(
      `SELECT id, summary, lifecycle, created_at, body_md, raw_yaml
         FROM org_guidance_primitives
        WHERE org_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'
        ORDER BY created_at DESC`,
      [org.id],
    );
    const nodeAuthoring = await c.query<ArticleRow>(
      `SELECT id, summary, lifecycle, created_at, body_md, raw_yaml
         FROM org_neuron_authoring_primitives
        WHERE org_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'
        ORDER BY created_at DESC`,
      [org.id],
    );
    return [guidance.rows, nodeAuthoring.rows] as const;
  });

  return {
    org,
    me,
    host: await loadHostConfig(),
    canEdit,
    guidanceArticles: guidanceRows.map(toGuidanceArticle),
    nodeAuthoringArticles: nodeAuthoringRows.map(toNodeAuthoringArticle),
  };
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `Articles of the Constitution · ${params.orgHandle} · Doco` }];
}

export default function OrgConstitution({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { org, me, canEdit, guidanceArticles, nodeAuthoringArticles } = loaderData;

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={orgBreadcrumb({
              orgSlug: org.slug,
              pageLabel: "Articles of the Constitution",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">
            Articles of the Constitution · <span className="font-mono">{org.slug}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rules that govern how nodes get added to every doco owned by {org.slug}.{" "}
            {AGENT_EXPOSURE_NOTE}
          </p>
          {!canEdit ? (
            <p className="mt-2 text-xs italic text-muted-foreground">
              Only an org owner can add articles. You are viewing read-only.
            </p>
          ) : null}
        </header>

        <ArticleSection
          title="Guidance articles"
          entityType="guidance_primitive"
          description={GUIDANCE_ARTICLE_EXPLAINER}
          addHref={canEdit ? `/orgs/${org.slug}/constitution/guidance/new` : null}
          editHrefBase={canEdit ? `/orgs/${org.slug}/constitution/guidance` : null}
          items={guidanceArticles}
          empty="No guidance articles yet."
        />

        <ArticleSection
          title="Node-authoring articles"
          entityType="neuron_authoring_primitive"
          description={NODE_AUTHORING_ARTICLE_EXPLAINER}
          addHref={canEdit ? `/orgs/${org.slug}/constitution/node-authoring/new` : null}
          editHrefBase={canEdit ? `/orgs/${org.slug}/constitution/node-authoring` : null}
          items={nodeAuthoringArticles}
          empty="No node-authoring articles yet."
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
  empty,
}: {
  title: string;
  entityType: "guidance_primitive" | "neuron_authoring_primitive";
  description: string;
  addHref: string | null;
  editHrefBase: string | null;
  items: (GuidanceArticleItem | NodeAuthoringArticleItem)[];
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
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {articleFullText({ summary: item.summary, body: item.body })}
                    </p>
                    {"evaluationKind" in item ? (
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                        <span>{item.evaluationKind}</span>
                        <span>{item.predicateKind}</span>
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {item.lifecycle ?? "active"}
                  </span>
                  {editHrefBase ? (
                    <Link
                      to={`${editHrefBase}/${item.id}/edit`}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-muted"
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
