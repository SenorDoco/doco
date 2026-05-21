// /orgs/:orgHandle/constitution — org-level constitution landing.
//
// Mirrors /:docoHandle/constitution. Articles authored here apply to
// every Doco the org owns. The edit gate is org-owner.

import { getOrgRole, withClient } from "@doco/db";
import { Link } from "react-router";
import { parse as parseYaml } from "yaml";
import { Card, CardContent } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipalAsync } from "~/lib/session";

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
         FROM org_guidance_articles
        WHERE org_id = $1
        ORDER BY created_at DESC`,
      [org.id],
    );
    const nodeAuthoring = await c.query<ArticleRow>(
      `SELECT id, summary, lifecycle, created_at, body_md, raw_yaml
         FROM org_node_authoring_articles
        WHERE org_id = $1
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
  return [{ title: `Constitution · ${params.orgHandle} · Doco` }];
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
      <SingleColumnPageMain className="py-6 space-y-6">
        <header className="space-y-3">
          <h1 className="text-xl font-semibold tracking-tight">
            Constitution · <span className="font-mono">{org.slug}</span>
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            This constitution applies to every Doco owned by{" "}
            <Link to="/orgs" className="underline">
              {org.slug}
            </Link>
            . Articles come in two kinds:
          </p>
          <ul className="ml-4 list-disc space-y-2 text-sm leading-6 text-muted-foreground">
            <li>
              <strong className="text-foreground">Guidance articles</strong> are prose-only.
              Contributors read them while working; no automated check is performed. Use them for
              taste-level conventions and process expectations that should hold across every project
              in the org.
            </li>
            <li>
              <strong className="text-foreground">Node authoring articles</strong> carry a predicate
              the host evaluates whenever a node is captured in any of the org's Docos.
              Deterministic predicates check structural properties; probabilistic specs delegate to
              the host's LLM judge. Each article sets <code>on_violation</code> to block, warn, or
              log.
            </li>
          </ul>
          <p className="text-sm leading-6 text-muted-foreground">
            Agents fetch every article they have read-or-above access to from{" "}
            <code>/api/v1/agent-bootstrap.json</code>. Org articles are returned alongside the
            per-Doco articles for every Doco the agent can reach.
          </p>
        </header>

        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/orgs/${org.slug}/constitution/guidance/new`}
              className="inline-flex items-center gap-2 rounded-md border border-primary bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <NodeTypeIcon nodeType="guidance_article" className="h-4 w-4" />
              Add guidance article
            </Link>
            <Link
              to={`/orgs/${org.slug}/constitution/node-authoring/new`}
              className="inline-flex items-center gap-2 rounded-md border border-primary bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <NodeTypeIcon nodeType="node_authoring_article" className="h-4 w-4" />
              Add node authoring article
            </Link>
          </div>
        ) : (
          <p className="text-xs italic text-muted-foreground">
            Only an org owner can add articles. You are viewing read-only.
          </p>
        )}

        <section className="space-y-4">
          <h2 className="text-base font-semibold tracking-tight">Articles of the Constitution</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <ArticleList
              title="Guidance articles"
              items={guidanceArticles}
              nodeType="guidance_article"
              empty="No guidance articles yet."
            />
            <ArticleList
              title="Node authoring articles"
              items={nodeAuthoringArticles}
              nodeType="node_authoring_article"
              empty="No node authoring articles yet."
            />
          </div>
        </section>
      </SingleColumnPageMain>
    </div>
  );
}

function ArticleList({
  title,
  nodeType,
  items,
  empty,
}: {
  title: string;
  nodeType: "guidance_article" | "node_authoring_article";
  items: (GuidanceArticleItem | NodeAuthoringArticleItem)[];
  empty: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <NodeTypeIcon nodeType={nodeType} className="mt-0.5 h-4 w-4" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">{item.summary}</div>
                    {"evaluationKind" in item ? (
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                        <span>{item.evaluationKind}</span>
                        <span>{item.predicateKind}</span>
                      </div>
                    ) : null}
                    {item.body ? (
                      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {item.body}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {item.lifecycle ?? "active"}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
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
