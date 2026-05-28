// /<doco-handle>/policies/neuron-authoring/new — standalone form for
// authoring a Doco-level neuron-authoring policy. Carries a predicate
// evaluated when a neuron is captured.

import { useState } from "react";
import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import {
  type NeuronAuthoringPolicyDraft,
  captureNeuronAuthoringPolicy,
} from "~/lib/capture.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { derivePolicySummary } from "~/lib/policy-copy";
import { resolvePrincipalIdForCollaborator } from "~/lib/principal-collaborator.server";

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
  const { docoSlug, handle, me, ownerSlug } = await loadDocoRouteForAdmin(request, params);
  return { ownerSlug, docoSlug, handle, me, host: await loadHostConfig() };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForAdmin(request, params);
  const { dir: docoDir, docoSlug, handle, ownerSlug } = ctx;
  const form = await request.formData();
  const body_md = String(form.get("body_md") ?? "").trim();
  const policy = derivePolicySummary(body_md);
  if (!policy) return Response.json({ error: "Policy is required." }, { status: 400 });
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
  const authorPrincipalId = ctx.me?.id
    ? await resolvePrincipalIdForCollaborator(ctx.meta.docoId, ctx.me.id)
    : null;
  const draft: NeuronAuthoringPolicyDraft = stampAuthenticatedCreator(
    {
      policy,
      body_md,
      evaluation_kind: evaluationKind,
      on_violation,
      authored_by_principal_id: authorPrincipalId ?? undefined,
      ...(lifecycle.length > 0 ? { fires_when_neuron_lifecycle: lifecycle } : {}),
      ...(evaluationKind === "probabilistic"
        ? { spec: String(form.get("probabilistic_spec") ?? "").trim() }
        : { predicate: String(form.get("deterministic_predicate") ?? "").trim() }),
    },
    ctx.me?.id,
  );
  const docoHost = new URL(request.url).origin;
  const result = await captureNeuronAuthoringPolicy(
    docoDir,
    ctx.meta.docoId,
    ownerSlug,
    docoSlug,
    draft,
    docoHost,
  );
  if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
  return redirect(`/${handle}/policies`);
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [
    {
      title: `New neuron-authoring policy · ${params.docoHandle ?? params.docoId ?? ""} · Doco`,
    },
  ];
}

export default function NewNeuronAuthoringPolicy({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, me } = loaderData;
  const actionData = useActionData<ActionError>();
  const [evaluationKind, setEvaluationKind] = useState<ArticleKind>("deterministic");
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={docoBreadcrumb({
              ownerSlug,
              handle,
              parent: { label: "Policies", to: `/${handle}/policies` },
              pageLabel: "New neuron-authoring policy",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">New neuron-authoring policy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            An automatic check that runs every time someone adds a neuron to this doco. Write a
            strict rule, or describe what an LLM judge should look for. Pick what happens on
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
                  Policy
                </span>
                <textarea
                  name="body_md"
                  required
                  rows={6}
                  placeholder="Write the policy."
                  className="mt-1 block w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              <fieldset className="flex flex-wrap gap-2">
                <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Evaluation kind
                </legend>
                {(["deterministic", "probabilistic"] as const).map((kind) => (
                  <label
                    key={kind}
                    className="neu-button inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold"
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
                        kind: "requires_synapse",
                        synapse_type: "serves",
                        target_neuron_type: "intent",
                        when_neuron_type: ["decision"],
                      },
                      null,
                      2,
                    )}
                    className="mt-1 block w-full rounded-md px-3 py-2 font-mono text-xs"
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
                    placeholder="Judge only the neuron being captured. Pass when..."
                    className="mt-1 block w-full rounded-md px-3 py-2 text-sm"
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
                    placeholder="active"
                    className="mt-1 block w-full rounded-md px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    On violation
                  </span>
                  <select
                    name="on_violation"
                    defaultValue="block"
                    className="mt-1 block rounded-md px-3 py-2 text-sm"
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
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Add neuron-authoring policy
                </button>
                <Link
                  to={`/${handle}/policies`}
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
