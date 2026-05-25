// /<doco-handle>/policies/guidance/new — standalone form for
// authoring a Doco-level guidance policy. Prose-only meta-rule; no
// automated check. The landing page at /<doco>/policies links
// here from the "Add guidance policy" button.

import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { captureGuidancePolicy } from "~/lib/capture.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { derivePolicySummary } from "~/lib/policy-copy";

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
  const docoHost = new URL(request.url).origin;

  const result = await captureGuidancePolicy(
    docoDir,
    ctx.meta.docoId,
    ownerSlug,
    docoSlug,
    {
      policy,
      body_md,
      authored_by_principal_id: ctx.me?.id,
      created_by_principal_id: ctx.me?.id,
    },
    docoHost,
  );
  if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
  return redirect(`/${handle}/policies`);
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `New guidance policy · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function NewGuidancePolicy({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, me } = loaderData;
  const actionData = useActionData<ActionError>();
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
              pageLabel: "New guidance policy",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">New guidance policy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A plain-English rule you want everyone working on this doco to follow. Nothing checks it
            automatically — it's a shared agreement.
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
                placeholder="Write the policy."
                className="block w-full rounded-md px-3 py-2 text-sm"
              />
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Add guidance policy
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
