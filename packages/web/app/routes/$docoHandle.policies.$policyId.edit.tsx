// /<doco>/policies/<id>/edit — modify or retire an existing policy.
// Owner-only (loadDocoRouteForAdmin gates both loader + action).
//
// POST intent=modify   → captures a new policy and retires the old one
//                        with `superseded_by: <new id>`.
// POST intent=retire   → flips the old to lifecycle='retired'.
// POST intent=activate → flips a retired policy back to lifecycle='active'
//                        (clearing any stale `superseded_by`).

import { Form, Link, redirect, useActionData } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PolicyFormFields } from "~/components/policy-form-fields";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { capturePolicy, loadPolicyForEdit, transitionPolicyLifecycle } from "~/lib/capture.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { policyDraftFromForm, policyFormInitialFromData } from "~/lib/policy-form";
import { resolvePrincipalIdForUser } from "~/lib/principal-user.server";

interface ActionError {
  error: string;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; policyId: string };
}) {
  const ctx = await loadDocoRouteForAdmin(request, params);
  const { docoSlug, handle, ownerSlug } = ctx;
  const result = await loadPolicyForEdit({
    scope: "doco",
    scopeId: ctx.meta.docoId,
    policyId: params.policyId,
  });
  if ("error" in result) {
    throw new Response(result.error, { status: result.status ?? 404 });
  }
  return {
    ownerSlug,
    docoSlug,
    handle,
    policyId: params.policyId,
    lifecycle: result.lifecycle,
    initial: policyFormInitialFromData(result.data),
    host: await loadHostConfig(),
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; policyId: string };
}) {
  const ctx = await loadDocoRouteForAdmin(request, params);
  const { docoSlug, handle, ownerSlug } = ctx;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "retire" || intent === "activate") {
    const result = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: ctx.meta.docoId,
      policyId: params.policyId,
      newLifecycle: intent === "activate" ? "active" : "retired",
      actorId: ctx.me?.id ?? null,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status ?? 400 });
    }
    return redirect(`/${handle}/policies`);
  }

  if (intent === "modify") {
    const parsed = policyDraftFromForm(form);
    if ("error" in parsed) return Response.json(parsed, { status: 400 });
    const docoDir = ctx.dir;
    const docoHost = new URL(request.url).origin;
    const authorPrincipalId = ctx.me?.id
      ? await resolvePrincipalIdForUser(ctx.meta.docoId, ctx.me.id)
      : null;
    const draft = stampAuthenticatedCreator(
      { ...parsed, authored_by_principal_id: authorPrincipalId ?? undefined },
      ctx.me?.id,
    );
    const captured = await capturePolicy(
      docoDir,
      ctx.meta.docoId,
      ownerSlug,
      docoSlug,
      draft,
      docoHost,
      { authoring: await authoringContextForRequest(request) },
    );
    if ("error" in captured) {
      return Response.json(captured, { status: captured.status ?? 400 });
    }
    const transitioned = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: ctx.meta.docoId,
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
  const { ownerSlug, handle, policyId, initial, lifecycle } = loaderData;
  const actionData = useActionData<ActionError>();
  const isRetired = lifecycle === "retired";

  return (
    <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <PageHeader
        breadcrumb={docoBreadcrumb({
          ownerSlug,
          handle,
          parent: { label: "Policies", to: `/${handle}/policies` },
          pageLabel: "Modify policy",
        })}
        title="Modify policy"
      >
        <p className="text-sm text-muted-foreground">
          Saving changes creates a new policy and retires this one with a <code>superseded_by</code>{" "}
          edge. Retiring leaves the old one in place. Either way the audit log retains the full
          history.
        </p>
      </PageHeader>
      <Card>
        <CardContent className="pt-6">
          {actionData?.error ? (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {actionData.error}
            </div>
          ) : null}
          {isRetired ? (
            <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
              This policy is <strong>retired</strong> and is not being enforced. Activate it to put
              it back into effect, or save changes to supersede it with a new policy.
            </div>
          ) : null}
          <Form method="post" className="space-y-4">
            <PolicyFormFields initial={initial} />
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="submit"
                name="intent"
                value="modify"
                className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
              >
                Save changes
              </button>
              {isRetired ? (
                <button
                  type="submit"
                  name="intent"
                  value="activate"
                  className="rounded-md border border-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400"
                >
                  Activate policy
                </button>
              ) : (
                <button
                  type="submit"
                  name="intent"
                  value="retire"
                  className="rounded-md border border-destructive px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10"
                >
                  Retire policy
                </button>
              )}
              <Link to={`/${handle}/policies`} className="ml-auto text-xs hover:underline">
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
  );
}
