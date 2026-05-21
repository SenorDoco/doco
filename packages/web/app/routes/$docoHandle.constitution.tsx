import { withClient } from "@doco/db";
import type { ReactNode } from "react";
import { useState } from "react";
import { Form, Link, redirect, useActionData } from "react-router";
import { parse as parseYaml } from "yaml";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type NodeAuthoringArticleDraft,
  captureGuidanceArticle,
  captureNodeAuthoringArticle,
} from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import {
  canEditConstitution,
  loadDocoForAdmin,
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

interface ActionError {
  error: string;
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

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const ctx = await loadDocoForAdmin(request, handle);
  const form = await request.formData();
  const articleType = String(form.get("article_type") ?? "");
  const summary = String(form.get("summary") ?? "").trim();
  const body_md = String(form.get("body_md") ?? "").trim();
  const docoDir = docoPath(handle);
  const docoHost = new URL(request.url).origin;

  const createdBy = ctx.me?.id ?? undefined;
  if (articleType === "guidance") {
    const result = await captureGuidanceArticle(
      docoDir,
      ctx.meta.docoId,
      ownerSlug,
      docoSlug,
      {
        summary,
        body_md,
        authored_by_username: ctx.me?.username,
        created_by_id: createdBy,
      },
      docoHost,
    );
    if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
    return redirect(`/${handle}/constitution`);
  }

  if (articleType === "node_authoring") {
    const evaluationKind =
      String(form.get("evaluation_kind") ?? "deterministic") === "probabilistic"
        ? "probabilistic"
        : "deterministic";
    const lifecycle = String(form.get("fires_when_node_lifecycle") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const draft: NodeAuthoringArticleDraft = {
      summary,
      body_md,
      evaluation_kind: evaluationKind,
      on_violation: readOnViolation(form),
      authored_by_username: ctx.me?.username,
      created_by_id: createdBy,
      ...(lifecycle.length > 0 ? { fires_when_node_lifecycle: lifecycle } : {}),
      ...(evaluationKind === "probabilistic"
        ? { spec: String(form.get("probabilistic_spec") ?? "").trim() }
        : { predicate: String(form.get("deterministic_predicate") ?? "").trim() }),
    };
    const result = await captureNodeAuthoringArticle(
      docoDir,
      ctx.meta.docoId,
      ownerSlug,
      docoSlug,
      draft,
      docoHost,
    );
    if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
    return redirect(`/${handle}/constitution`);
  }

  return Response.json({ error: "Unknown article type." }, { status: 400 });
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
  const actionData = useActionData<ActionError>();
  const [evaluationKind, setEvaluationKind] = useState<ArticleKind>("deterministic");

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <SingleColumnPageMain className="py-6 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Constitution</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {guidanceArticles.length} guidance · {nodeAuthoringArticles.length} node authoring
            </p>
          </div>
        </div>

        {actionData?.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {actionData.error}
          </div>
        ) : null}

        {canEdit ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <ArticleFormCard
              title="Add guidance article"
              icon="guidance_article"
              body={
                <Form method="post" className="space-y-3">
                  <input type="hidden" name="article_type" value="guidance" />
                  <ArticleSummaryInput placeholder="Prefer concrete examples over abstract prose." />
                  <ArticleBodyInput rows={7} />
                  <SubmitButton label="Add guidance article" />
                </Form>
              }
            />
            <ArticleFormCard
              title="Add node authoring article"
              icon="node_authoring_article"
              body={
                <Form method="post" className="space-y-3">
                  <input type="hidden" name="article_type" value="node_authoring" />
                  <ArticleSummaryInput placeholder="Every Decision cites at least one Intent." />
                  <fieldset className="flex flex-wrap gap-2">
                    <legend className="sr-only">Evaluation kind</legend>
                    {(["deterministic", "probabilistic"] as const).map((kind) => (
                      <label
                        key={kind}
                        className="inline-flex items-center gap-2 rounded-md border border-border bg-input px-3 py-2 text-xs font-semibold"
                      >
                        <input
                          type="radio"
                          name="evaluation_kind"
                          value={kind}
                          checked={evaluationKind === kind}
                          onChange={() => setEvaluationKind(kind)}
                        />
                        {kind}
                      </label>
                    ))}
                  </fieldset>
                  {evaluationKind === "deterministic" ? (
                    <label className="block">
                      <FieldLabel>Predicate JSON</FieldLabel>
                      <textarea
                        name="deterministic_predicate"
                        rows={7}
                        defaultValue={JSON.stringify(
                          {
                            kind: "requires_edge",
                            edge_type: "serves",
                            target_node_type: "intent",
                            when_node_type: ["decision"],
                          },
                          null,
                          2,
                        )}
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs"
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <FieldLabel>Probabilistic spec</FieldLabel>
                      <textarea
                        name="probabilistic_spec"
                        rows={7}
                        placeholder="Judge only the node being captured. Pass when..."
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      />
                    </label>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <FieldLabel>Fires on lifecycles</FieldLabel>
                      <input
                        name="fires_when_node_lifecycle"
                        placeholder="active"
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>On violation</FieldLabel>
                      <select
                        name="on_violation"
                        defaultValue="block"
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      >
                        <option value="block">block</option>
                        <option value="warn">warn</option>
                        <option value="log">log</option>
                      </select>
                    </label>
                  </div>
                  <ArticleBodyInput rows={4} />
                  <SubmitButton label="Add node authoring article" />
                </Form>
              }
            />
          </div>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-base font-semibold tracking-tight">
            Articles of the Constitution
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <ArticleList
              title="Guidance articles"
              handle={handle}
              nodeType="guidance_article"
              items={guidanceArticles}
              empty="No guidance articles yet."
            />
            <ArticleList
              title="Node authoring articles"
              handle={handle}
              nodeType="node_authoring_article"
              items={nodeAuthoringArticles}
              empty="No node authoring articles yet."
            />
          </div>
        </section>
      </SingleColumnPageMain>
    </div>
  );
}

function ArticleFormCard({
  title,
  icon,
  body,
}: {
  title: string;
  icon: string;
  body: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <NodeTypeIcon nodeType={icon} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function ArticleSummaryInput({ placeholder }: { placeholder: string }) {
  return (
    <label className="block">
      <FieldLabel>Summary</FieldLabel>
      <input
        type="text"
        name="summary"
        required
        maxLength={300}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
      />
    </label>
  );
}

function ArticleBodyInput({ rows }: { rows: number }) {
  return (
    <label className="block">
      <FieldLabel>Body</FieldLabel>
      <textarea
        name="body_md"
        rows={rows}
        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
      />
    </label>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function SubmitButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="rounded-md border border-primary bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
    >
      {label}
    </button>
  );
}

function ArticleList({
  title,
  handle,
  nodeType,
  items,
  empty,
}: {
  title: string;
  handle: string;
  nodeType: "guidance_article" | "node_authoring_article";
  items: (GuidanceArticleItem | NodeAuthoringArticleItem)[];
  empty: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
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

function readOnViolation(form: FormData): "block" | "warn" | "log" {
  const value = String(form.get("on_violation") ?? "block");
  return value === "warn" || value === "log" ? value : "block";
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
