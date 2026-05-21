// /orgs/:orgHandle/constitution/node-authoring/new — standalone form
// for authoring an org-level node authoring article. The predicate
// fires for every Doco the org owns.

import { getOrgRole, withClient } from "@doco/db";
import { useState } from "react";
import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import {
  type NodeAuthoringArticleDraft,
  captureOrgNodeAuthoringArticle,
} from "~/lib/capture.server";
import { deriveArticleSummary } from "~/lib/constitution-copy";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipalAsync } from "~/lib/session";

type ArticleKind = "deterministic" | "probabilistic";

interface OrgRow {
  id: string;
  slug: string;
  name: string;
}

interface ActionError {
  error: string;
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
  if (!org) throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    throw redirect(
      `/sign-in?next=${encodeURIComponent(`/orgs/${org.slug}/constitution/node-authoring/new`)}`,
    );
  }
  const role = await getOrgRole(org.id, me.id);
  if (role !== "owner") {
    throw new Response("Only org owners can add articles.", { status: 403 });
  }
  return { org, me, host: await loadHostConfig() };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { orgHandle: string };
}) {
  const org = await resolveOrgByHandle(params.orgHandle);
  if (!org) throw new Response(`Org "${params.orgHandle}" not found.`, { status: 404 });
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    throw redirect(
      `/sign-in?next=${encodeURIComponent(`/orgs/${org.slug}/constitution/node-authoring/new`)}`,
    );
  }
  const role = await getOrgRole(org.id, me.id);
  if (role !== "owner") {
    throw new Response("Only org owners can add articles.", { status: 403 });
  }
  const form = await request.formData();
  const body_md = String(form.get("body_md") ?? "").trim();
  const summary = deriveArticleSummary(body_md);
  if (!summary) return Response.json({ error: "Article is required." }, { status: 400 });
  const evaluationKind =
    String(form.get("evaluation_kind") ?? "deterministic") === "probabilistic"
      ? "probabilistic"
      : "deterministic";
  const lifecycle = String(form.get("fires_when_node_lifecycle") ?? "")
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
    ...(lifecycle.length > 0 ? { fires_when_node_lifecycle: lifecycle } : {}),
    ...(evaluationKind === "probabilistic"
      ? { spec: String(form.get("probabilistic_spec") ?? "").trim() }
      : { predicate: String(form.get("deterministic_predicate") ?? "").trim() }),
  };
  const result = await captureOrgNodeAuthoringArticle(org.id, draft);
  if ("error" in result) return Response.json(result, { status: 400 });
  return redirect(`/orgs/${org.slug}/constitution`);
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `New node-authoring article · ${params.orgHandle} · Doco` }];
}

export default function NewOrgNodeAuthoringArticle({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { org, me } = loaderData;
  const actionData = useActionData<ActionError>();
  const [evaluationKind, setEvaluationKind] = useState<ArticleKind>("deterministic");
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={orgBreadcrumb({
              orgSlug: org.slug,
              parent: { label: "Constitution", to: `/orgs/${org.slug}/constitution` },
              pageLabel: "New node-authoring article",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">
            New node-authoring article · <span className="font-mono">{org.slug}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            An automatic check that runs every time someone adds a node in any of this org's docos.
            Write a strict rule, or describe what an LLM judge should look for. Pick what happens on
            failure: block the capture, warn, or just log.
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
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Article
                </span>
                <textarea
                  name="body_md"
                  required
                  rows={6}
                  placeholder="Write the article. First line shows in the list view; rest is the full text contributors read."
                  className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                />
              </label>
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
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Probabilistic spec
                  </span>
                  <textarea
                    name="probabilistic_spec"
                    rows={10}
                    placeholder="Judge only the node being captured. Pass when..."
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
                    name="fires_when_node_lifecycle"
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
                    defaultValue="block"
                    className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                  >
                    <option value="block">block</option>
                    <option value="warn">warn</option>
                    <option value="log">log</option>
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Add node-authoring article
                </button>
                <Link
                  to={`/orgs/${org.slug}/constitution`}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
