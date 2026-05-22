// /orgs/<org>/constitution/<entityType>/<id>/edit — modify or abandon
// an existing org-level constitution article. Owner-only.
//
// POST intent=modify  → captures a new primitive with `supersedes: <id>`
//                       and flips the old to lifecycle='superseded'.
// POST intent=abandon → flips the old to lifecycle='abandoned'.

import { getOrgRole, withClient } from "@doco/db";
import { useState } from "react";
import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import {
  type NodeAuthoringArticleDraft,
  captureOrgGuidanceArticle,
  captureOrgNodeAuthoringArticle,
  loadArticleForEdit,
  transitionArticleLifecycle,
} from "~/lib/capture.server";
import { deriveArticleSummary } from "~/lib/constitution-copy";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

type EntityType = "guidance_primitive" | "neuron_authoring_primitive";
type ArticleKind = "deterministic" | "probabilistic";

interface ActionError {
  error: string;
}

interface OrgRow {
  id: string;
  slug: string;
  name: string;
}

function parseNodeType(raw: string | undefined): EntityType | null {
  if (raw === "guidance" || raw === "guidance_primitive") return "guidance_primitive";
  if (raw === "node-authoring" || raw === "neuron_authoring_primitive") return "neuron_authoring_primitive";
  return null;
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
  params: { orgHandle: string; entityType: string; articleId: string };
}) {
  const entityType = parseNodeType(params.entityType);
  if (!entityType) throw new Response("Unknown primitive kind.", { status: 404 });
  const org = await resolveOrgByHandle(params.orgHandle);
  if (!org) throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    throw redirect(
      `/sign-in?next=${encodeURIComponent(
        `/orgs/${org.slug}/constitution/${params.entityType}/${params.articleId}/edit`,
      )}`,
    );
  }
  const role = await getOrgRole(org.id, me.id);
  if (role !== "owner") {
    throw new Response("Only org owners can edit articles.", { status: 403 });
  }
  const result = await loadArticleForEdit({
    scope: "org",
    scopeId: org.id,
    entityType,
    articleId: params.articleId,
  });
  if ("error" in result) {
    throw new Response(result.error, { status: result.status ?? 404 });
  }
  return {
    org,
    me,
    entityType,
    articleId: params.articleId,
    body_md: result.body_md,
    lifecycle: result.lifecycle,
    raw_yaml: result.raw_yaml,
    host: await loadHostConfig(),
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { orgHandle: string; entityType: string; articleId: string };
}) {
  const entityType = parseNodeType(params.entityType);
  if (!entityType) throw new Response("Unknown primitive kind.", { status: 404 });
  const org = await resolveOrgByHandle(params.orgHandle);
  if (!org) throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  const me = await getCurrentPrincipalAsync(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent(`/orgs/${org.slug}/constitution`)}`);
  const role = await getOrgRole(org.id, me.id);
  if (role !== "owner") {
    throw new Response("Only org owners can edit articles.", { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "abandon") {
    const result = await transitionArticleLifecycle({
      scope: "org",
      scopeId: org.id,
      entityType,
      articleId: params.articleId,
      newLifecycle: "abandoned",
      actorId: me.id,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status ?? 400 });
    }
    return redirect(`/orgs/${org.slug}/constitution`);
  }

  if (intent === "modify") {
    const body_md = String(form.get("body_md") ?? "").trim();
    const summary = deriveArticleSummary(body_md);
    if (!summary) return Response.json({ error: "Article is required." }, { status: 400 });
    const supersedes = params.articleId;

    let captured: Awaited<
      ReturnType<typeof captureOrgGuidanceArticle | typeof captureOrgNodeAuthoringArticle>
    >;
    if (entityType === "guidance_primitive") {
      captured = await captureOrgGuidanceArticle(
        org.id,
        {
          summary,
          body_md,
          authored_by_username: me.username,
          created_by_id: me.id,
        },
        { supersedes },
      );
    } else {
      const evaluationKind =
        String(form.get("evaluation_kind") ?? "deterministic") === "probabilistic"
          ? "probabilistic"
          : "deterministic";
      const lifecycle = String(form.get("fires_when_neuron_lifecycle") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const onViolationRaw = String(form.get("on_violation") ?? "block");
      const on_violation =
        onViolationRaw === "warn" || onViolationRaw === "log" ? onViolationRaw : "block";
      const draft: NodeAuthoringArticleDraft = {
        summary,
        body_md,
        evaluation_kind: evaluationKind,
        on_violation,
        authored_by_username: me.username,
        created_by_id: me.id,
        ...(lifecycle.length > 0 ? { fires_when_neuron_lifecycle: lifecycle } : {}),
        ...(evaluationKind === "probabilistic"
          ? { spec: String(form.get("probabilistic_spec") ?? "").trim() }
          : { predicate: String(form.get("deterministic_predicate") ?? "").trim() }),
      };
      captured = await captureOrgNodeAuthoringArticle(org.id, draft, { supersedes });
    }
    if ("error" in captured) {
      return Response.json(captured, { status: 400 });
    }
    const transitioned = await transitionArticleLifecycle({
      scope: "org",
      scopeId: org.id,
      entityType,
      articleId: params.articleId,
      newLifecycle: "superseded",
      actorId: me.id,
      reason: `superseded_by:${captured.id}`,
    });
    if ("error" in transitioned) {
      return Response.json({ error: transitioned.error }, { status: 500 });
    }
    return redirect(`/orgs/${org.slug}/constitution`);
  }

  return Response.json({ error: "Unknown intent." }, { status: 400 });
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `Modify article · ${params.orgHandle} · Doco` }];
}

export default function EditOrgArticle({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { org, me, entityType, articleId, body_md, raw_yaml } = loaderData;
  const actionData = useActionData<ActionError>();
  const isNodeAuthoring = entityType === "neuron_authoring_primitive";
  const initialEvalKind: ArticleKind =
    raw_yaml.evaluation_kind === "probabilistic" ? "probabilistic" : "deterministic";
  const [evaluationKind, setEvaluationKind] = useState<ArticleKind>(initialEvalKind);
  const initialPredicate =
    raw_yaml.predicate && typeof raw_yaml.predicate === "object"
      ? JSON.stringify(raw_yaml.predicate, null, 2)
      : "";
  const initialSpec =
    raw_yaml.predicate &&
    typeof raw_yaml.predicate === "object" &&
    (raw_yaml.predicate as { kind?: string }).kind === "probabilistic" &&
    typeof (raw_yaml.predicate as { spec?: string }).spec === "string"
      ? (raw_yaml.predicate as { spec: string }).spec
      : "";
  const initialFiresOn = Array.isArray(raw_yaml.fires_when_neuron_lifecycle)
    ? (raw_yaml.fires_when_neuron_lifecycle as string[]).join(", ")
    : "";
  const initialOnViolation =
    typeof raw_yaml.on_violation === "string" ? raw_yaml.on_violation : "block";

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={orgBreadcrumb({
              orgSlug: org.slug,
              parent: { label: "Constitution", to: `/orgs/${org.slug}/constitution` },
              pageLabel: `Modify ${isNodeAuthoring ? "neuron-authoring" : "guidance"} primitive`,
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">
            Modify {isNodeAuthoring ? "neuron-authoring" : "guidance"} primitive ·{" "}
            <span className="font-mono">{org.slug}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saving changes creates a new article and marks this one as <em>superseded</em>.
            Abandoning leaves the old one in place but flips it to <em>abandoned</em>. Either way
            the audit log retains the full history.
          </p>
        </header>
        <Card>
          <CardContent className="pt-6">
            {actionData?.error ? (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {actionData.error}
              </div>
            ) : null}
            <Form method="post" className="space-y-4">
              <textarea
                name="body_md"
                required
                rows={12}
                defaultValue={body_md}
                placeholder="Write the article."
                className="block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
              {isNodeAuthoring ? (
                <>
                  <fieldset className="flex flex-wrap gap-2">
                    <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Evaluation kind
                    </legend>
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
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Predicate JSON
                      </span>
                      <textarea
                        name="deterministic_predicate"
                        rows={10}
                        defaultValue={initialPredicate}
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs"
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Probabilistic spec
                      </span>
                      <textarea
                        name="probabilistic_spec"
                        rows={10}
                        defaultValue={initialSpec}
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      />
                    </label>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Fires on lifecycles (comma-separated)
                      </span>
                      <input
                        name="fires_when_neuron_lifecycle"
                        defaultValue={initialFiresOn}
                        placeholder="active"
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        On violation
                      </span>
                      <select
                        name="on_violation"
                        defaultValue={initialOnViolation}
                        className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      >
                        <option value="block">block</option>
                        <option value="warn">warn</option>
                        <option value="log">log</option>
                      </select>
                    </label>
                  </div>
                </>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="submit"
                  name="intent"
                  value="modify"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Save changes
                </button>
                <button
                  type="submit"
                  name="intent"
                  value="abandon"
                  className="rounded-md border border-destructive px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10"
                >
                  Abandon article
                </button>
                <Link
                  to={`/orgs/${org.slug}/constitution`}
                  className="ml-auto text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </Link>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Article id: <code>{articleId}</code>
              </p>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
