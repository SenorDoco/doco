// /<doco>/policies/<id> — the canonical, linkable page for a single policy.
//
// Anyone who can read the Doco can open it (so agents and humans can link to a
// policy by URL when they cite it). The owner of the Doco — or of its owning
// workspace — additionally gets the controls to Modify (→ the edit form) and
// Revoke (retire) the policy; `canEditPolicies` resolves owner from either
// source. Revoking retires the policy without deleting it, so the URL keeps
// resolving and any earlier reference stays valid.

import { summarizePredicate } from "@doco/shared";
import { Form, Link, redirect, useActionData } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { PageHeader } from "~/components/page-header";
import { PolicyView, toPolicyItem } from "~/components/policy-view";
import { SiteHeader } from "~/components/site-header";
import { loadPolicyForEdit, transitionPolicyLifecycle } from "~/lib/capture.server";
import {
  canEditPolicies,
  loadDocoRouteForAdmin,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";

interface ActionError {
  error: string;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string; policyId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const result = await loadPolicyForEdit({
    scope: "doco",
    scopeId: ctx.meta.docoId,
    policyId: params.policyId,
  });
  if ("error" in result) {
    throw new Response(result.error, { status: result.status ?? 404 });
  }
  const data = result.data;
  const item = toPolicyItem({
    id: params.policyId,
    kind: typeof data.kind === "string" ? data.kind : null,
    lifecycle: result.lifecycle,
    created_at: typeof data.created_at === "string" ? data.created_at : null,
    data,
  });
  const summary = item.predicate ? summarizePredicate(item.predicate) : "";
  return {
    ownerSlug,
    docoSlug,
    handle,
    me: ctx.me,
    host: await loadHostConfig(),
    canEdit: await canEditPolicies(ctx.meta, ctx.me?.id ?? null),
    policyId: params.policyId,
    item,
    summary,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string; policyId: string };
}) {
  const ctx = await loadDocoRouteForAdmin(request, params);
  const { handle } = ctx;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke") {
    const result = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: ctx.meta.docoId,
      policyId: params.policyId,
      newLifecycle: "retired",
      actorId: ctx.me?.id ?? null,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status ?? 400 });
    }
    return redirect(`/${handle}/policies`);
  }

  return Response.json({ error: "Unknown intent." }, { status: 400 });
}

export function meta({
  data,
  params,
}: {
  data: Awaited<ReturnType<typeof loader>> | undefined;
  params: { docoHandle?: string; docoId?: string };
}) {
  const label = data?.summary?.trim();
  const doco = params.docoHandle ?? params.docoId ?? "";
  const lead = label ? `${label} · ` : "";
  return [{ title: `${lead}Policy · ${doco} · Doco` }];
}

export default function PolicyDetail({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, handle, me, canEdit, item, policyId } = loaderData;
  const actionData = useActionData<ActionError>();
  const isRetired = (item.lifecycle ?? "active") === "retired";

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <PageHeader
          breadcrumb={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "Policies", to: `/${handle}/policies` },
            pageLabel: "Policy",
          })}
          title="Policy"
        >
          <p className="text-sm text-muted-foreground">
            One authoring policy for{" "}
            <Link to={`/${handle}`} className="font-medium hover:underline">
              {handle}
            </Link>
            . This page has a stable URL — link to it when you reference this policy.
          </p>
        </PageHeader>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <NodeTypeIcon entityType="policy" className="h-4 w-4" />
                <span>Policy</span>
                <span className="neu-surface rounded px-2 py-1 font-mono text-[10px] font-normal text-muted-foreground">
                  {item.lifecycle ?? "active"}
                </span>
              </CardTitle>
              {canEdit ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    to={`/${handle}/policies/${policyId}/edit`}
                    className="neu-button rounded-md px-3 py-1.5 text-sm font-semibold text-foreground"
                  >
                    Modify
                  </Link>
                  {isRetired ? null : (
                    <Form method="post">
                      <button
                        type="submit"
                        name="intent"
                        value="revoke"
                        className="rounded-md border border-destructive px-3 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive/10"
                      >
                        Revoke
                      </button>
                    </Form>
                  )}
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {actionData?.error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {actionData.error}
              </div>
            ) : null}
            <PolicyView item={item} />
            <p className="text-[11px] text-muted-foreground">
              Policy id: <code>{policyId}</code>
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
