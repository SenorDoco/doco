// /<doco-handle>/constitution/node-authoring/new — standalone form for
// authoring a Doco-level node authoring article. Carries a predicate
// evaluated when a node is captured.

import { useState } from "react";
import { Form, Link, redirect, useActionData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { type NodeAuthoringArticleDraft, captureNodeAuthoringArticle } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";

type ArticleKind = "deterministic" | "probabilistic";

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
  const { me } = await loadDocoForAdmin(request, handle);
  return { ownerSlug, docoSlug, handle, me, host: await loadHostConfig() };
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
  const summary = String(form.get("summary") ?? "").trim();
  const body_md = String(form.get("body_md") ?? "").trim();
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
    authored_by_username: ctx.me?.username,
    created_by_id: ctx.me?.id,
    ...(lifecycle.length > 0 ? { fires_when_node_lifecycle: lifecycle } : {}),
    ...(evaluationKind === "probabilistic"
      ? { spec: String(form.get("probabilistic_spec") ?? "").trim() }
      : { predicate: String(form.get("deterministic_predicate") ?? "").trim() }),
  };
  const docoDir = docoPath(handle);
  const docoHost = new URL(request.url).origin;
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

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `New node authoring article · ${params.docoId} · Doco` }];
}

export default function NewNodeAuthoringArticle({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, me } = loaderData;
  const actionData = useActionData<ActionError>();
  const [evaluationKind, setEvaluationKind] = useState<ArticleKind>("deterministic");
  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <SingleColumnPageMain className="py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>New node authoring article</CardTitle>
            <CardDescription>
              Carries a predicate the host evaluates whenever a node is captured. Deterministic
              predicates check structural properties (e.g. "every Decision cites at least one
              Intent"); probabilistic specs delegate to the host's LLM judge. Use{" "}
              <code>on_violation</code> to block, warn, or log.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {actionData?.error ? (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {actionData.error}
              </div>
            ) : null}
            <Form method="post" className="space-y-4">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Summary
                </span>
                <input
                  type="text"
                  name="summary"
                  required
                  maxLength={300}
                  placeholder="Every Decision cites at least one Intent."
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
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Body
                </span>
                <textarea
                  name="body_md"
                  rows={6}
                  placeholder="Markdown body. Rationale, examples, edge cases."
                  className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                />
              </label>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  className="rounded-md border border-primary bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Add node authoring article
                </button>
                <Link
                  to={`/${handle}/constitution`}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
