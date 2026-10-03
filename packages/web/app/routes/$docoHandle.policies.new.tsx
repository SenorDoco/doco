// /<doco-handle>/policies/new — standalone form for authoring a Doco-level
// policy. One form for all three kinds: suggestion, deterministic,
// probabilistic. Owner-only (loadDocoRouteForAdmin gates loader + action).

import { Form, Link, redirect, useActionData } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PolicyFormFields } from "~/components/policy-form-fields";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { capturePolicy } from "~/lib/capture.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { policyDraftFromForm } from "~/lib/policy-form";
import { resolvePrincipalIdForUser } from "~/lib/principal-user.server";

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
  const { docoSlug, handle, ownerSlug } = await loadDocoRouteForAdmin(request, params);
  return { ownerSlug, docoSlug, handle, host: await loadHostConfig() };
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
  const parsed = policyDraftFromForm(form);
  if ("error" in parsed) return Response.json(parsed, { status: 400 });
  const authorPrincipalId = ctx.me?.id
    ? await resolvePrincipalIdForUser(ctx.meta.docoId, ctx.me.id)
    : null;
  const draft = stampAuthenticatedCreator(
    { ...parsed, authored_by_principal_id: authorPrincipalId ?? undefined },
    ctx.me?.id,
  );
  const docoHost = new URL(request.url).origin;
  const result = await capturePolicy(
    docoDir,
    ctx.meta.docoId,
    ownerSlug,
    docoSlug,
    draft,
    docoHost,
    {
      authoring: await authoringContextForRequest(request),
    },
  );
  if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
  return redirect(`/${handle}/policies`);
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `New policy · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function NewPolicy({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, handle } = loaderData;
  const actionData = useActionData<ActionError>();
  return (
    <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <PageHeader
        breadcrumb={docoBreadcrumb({
          ownerSlug,
          handle,
          parent: { label: "Policies", to: `/${handle}/policies` },
          pageLabel: "New policy",
        })}
        title="New policy"
      >
        <p className="text-sm text-muted-foreground">
          Every policy is an authoring policy. Pick a kind, then describe the instruction (for
          suggestion / probabilistic) or compose the structural check (for deterministic).
        </p>
      </PageHeader>
      <Card>
        <CardContent className="pt-6">
          {actionData?.error ? (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {actionData.error}
            </div>
          ) : null}
          <Form method="post" className="space-y-4">
            <PolicyFormFields />
            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
              >
                Add policy
              </button>
              <Link to={`/${handle}/policies`} className="text-xs hover:underline">
                Cancel
              </Link>
            </div>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}
