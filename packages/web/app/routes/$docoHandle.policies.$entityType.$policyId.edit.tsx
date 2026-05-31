// /<doco>/policies/<entityType>/<id>/edit — modify or retire an
// existing policy. Owner-only (loadDocoRouteForAdmin gates
// both loader + action).
//
// POST intent=modify → captures a new policy and retires the old one
//                      with `superseded_by: <new id>`.
// POST intent=retire → flips the old to lifecycle='retired'.

import { useState } from "react";
import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import {
  type NodeAuthoringPolicyDraft,
  captureGuidancePolicy,
  captureNodeAuthoringPolicy,
  loadPolicyForEdit,
  transitionPolicyLifecycle,
} from "~/lib/capture.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { derivePolicySummary } from "~/lib/policy-copy";
import { resolvePrincipalIdForUser } from "~/lib/principal-user.server";

type EntityType = "guidance_policy" | "node_authoring_policy";
type ArticleKind = "deterministic" | "probabilistic";

interface ActionError {
  error: string;
}

function parsePolicyType(raw: string | undefined): EntityType | null {
  if (raw === "guidance" || raw === "guidance_policy") return "guidance_policy";
  if (raw === "node-authoring" || raw === "node_authoring_policy") return "node_authoring_policy";
  return null;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; entityType: string; policyId: string };
}) {
  const entityType = parsePolicyType(params.entityType);
  if (!entityType) throw new Response("Unknown policy kind.", { status: 404 });
  const ctx = await loadDocoRouteForAdmin(request, params);
  const { docoSlug, handle, ownerSlug } = ctx;
  const result = await loadPolicyForEdit({
    scope: "doco",
    scopeId: ctx.meta.docoId,
    entityType,
    policyId: params.policyId,
  });
  if ("error" in result) {
    throw new Response(result.error, { status: result.status ?? 404 });
  }
  return {
    ownerSlug,
    docoSlug,
    handle,
    me: ctx.me,
    entityType,
    policyId: params.policyId,
    body_md: result.body_md,
    lifecycle: result.lifecycle,
    data: result.data,
    host: await loadHostConfig(),
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; entityType: string; policyId: string };
}) {
  const entityType = parsePolicyType(params.entityType);
  if (!entityType) throw new Response("Unknown policy kind.", { status: 404 });
  const ctx = await loadDocoRouteForAdmin(request, params);
  const { docoSlug, handle, ownerSlug } = ctx;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "retire") {
    const result = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: ctx.meta.docoId,
      entityType,
      policyId: params.policyId,
      newLifecycle: "retired",
      actorId: ctx.me?.id ?? null,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status ?? 400 });
    }
    return redirect(`/${handle}/policies`);
  }

  if (intent === "modify") {
    const body_md = String(form.get("body_md") ?? "").trim();
    const policy = derivePolicySummary(body_md);
    if (!policy) return Response.json({ error: "Policy is required." }, { status: 400 });
    const docoDir = ctx.dir;
    const docoHost = new URL(request.url).origin;
    const authorPrincipalId = ctx.me?.id
      ? await resolvePrincipalIdForUser(ctx.meta.docoId, ctx.me.id)
      : null;
    let captured: Awaited<
      ReturnType<typeof captureGuidancePolicy | typeof captureNodeAuthoringPolicy>
    >;
    if (entityType === "guidance_policy") {
      const draft = stampAuthenticatedCreator(
        {
          policy,
          body_md,
          authored_by_principal_id: authorPrincipalId ?? undefined,
        },
        ctx.me?.id,
      );
      captured = await captureGuidancePolicy(
        docoDir,
        ctx.meta.docoId,
        ownerSlug,
        docoSlug,
        draft,
        docoHost,
      );
    } else {
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
      const draft: NodeAuthoringPolicyDraft = stampAuthenticatedCreator(
        {
          policy,
          body_md,
          evaluation_kind: evaluationKind,
          on_violation,
          authored_by_principal_id: authorPrincipalId ?? undefined,
          ...(lifecycle.length > 0 ? { fires_when_node_lifecycle: lifecycle } : {}),
          ...(evaluationKind === "probabilistic"
            ? { spec: String(form.get("probabilistic_spec") ?? "").trim() }
            : { predicate: String(form.get("deterministic_predicate") ?? "").trim() }),
        },
        ctx.me?.id,
      );
      captured = await captureNodeAuthoringPolicy(
        docoDir,
        ctx.meta.docoId,
        ownerSlug,
        docoSlug,
        draft,
        docoHost,
      );
    }
    if ("error" in captured) {
      return Response.json(captured, { status: captured.status ?? 400 });
    }
    const transitioned = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: ctx.meta.docoId,
      entityType,
      policyId: params.policyId,
      newLifecycle: "retired",
      supersededBy: captured.id,
      actorId: ctx.me?.id ?? null,
      reason: `superseded_by:${captured.id}`,
    });
    if ("error" in transitioned) {
      return Response.json({ error: transitioned.error }, { status: 500 });
    }
    return redirect(`/${handle}/policies`);
  }

  return Response.json({ error: "Unknown intent." }, { status: 400 });
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Modify policy · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function EditPolicy({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, me, entityType, policyId, body_md, data } = loaderData;
  const actionData = useActionData<ActionError>();
  const isNodeAuthoring = entityType === "node_authoring_policy";
  const initialEvalKind: ArticleKind =
    data.evaluation_kind === "probabilistic" ? "probabilistic" : "deterministic";
  const [evaluationKind, setEvaluationKind] = useState<ArticleKind>(initialEvalKind);
  const initialPredicate =
    data.predicate && typeof data.predicate === "object"
      ? JSON.stringify(data.predicate, null, 2)
      : "";
  const initialSpec =
    data.predicate &&
    typeof data.predicate === "object" &&
    (data.predicate as { kind?: string }).kind === "probabilistic" &&
    typeof (data.predicate as { spec?: string }).spec === "string"
      ? (data.predicate as { spec: string }).spec
      : "";
  const initialFiresOn = Array.isArray(data.fires_when_node_lifecycle)
    ? (data.fires_when_node_lifecycle as string[]).join(", ")
    : "";
  const initialOnViolation = typeof data.on_violation === "string" ? data.on_violation : "block";

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={docoBreadcrumb({
              ownerSlug,
              handle,
              parent: { label: "Policies", to: `/${handle}/policies` },
              pageLabel: `Modify ${isNodeAuthoring ? "node-authoring" : "guidance"} policy`,
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">
            Modify {isNodeAuthoring ? "node-authoring" : "guidance"} policy
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saving changes creates a new policy and retires this one with a{" "}
            <code>superseded_by</code> edge. Retiring leaves the old one in place. Either way the
            audit log retains the full history.
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
                placeholder="Write the policy."
                className="block w-full rounded-md px-3 py-2 text-sm"
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
                        defaultValue={initialPredicate}
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
                        defaultValue={initialSpec}
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
                        name="fires_when_node_lifecycle"
                        defaultValue={initialFiresOn}
                        placeholder="asserted"
                        className="mt-1 block w-full rounded-md px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        On violation
                      </span>
                      <select
                        name="on_violation"
                        defaultValue={initialOnViolation}
                        className="mt-1 block rounded-md px-3 py-2 text-sm"
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
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Save changes
                </button>
                <button
                  type="submit"
                  name="intent"
                  value="retire"
                  className="rounded-md border border-destructive px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10"
                >
                  Retire policy
                </button>
                <Link
                  to={`/${handle}/policies`}
                  className="ml-auto text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </Link>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Policy id: <code>{policyId}</code>
              </p>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
