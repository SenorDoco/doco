// /<doco-handle>/constitution/guidance/new — standalone form for
// authoring a Doco-level guidance article. Prose-only meta-rule; no
// automated check. The landing page at /<doco>/constitution links
// here from the "Add guidance article" button.

import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { captureGuidanceArticle } from "~/lib/capture.server";
import { deriveArticleSummary } from "~/lib/constitution-copy";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";

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
  const summary = deriveArticleSummary(body_md);
  if (!summary) return Response.json({ error: "Article is required." }, { status: 400 });
  const docoHost = new URL(request.url).origin;

  const result = await captureGuidanceArticle(
    docoDir,
    ctx.meta.docoId,
    ownerSlug,
    docoSlug,
    {
      summary,
      body_md,
      authored_by_username: ctx.me?.username,
      created_by_id: ctx.me?.id,
    },
    docoHost,
  );
  if ("error" in result) return Response.json(result, { status: result.status ?? 400 });
  return redirect(`/${handle}/constitution`);
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `New guidance article · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function NewGuidanceArticle({
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
              parent: { label: "Constitution", to: `/${handle}/constitution` },
              pageLabel: "New guidance article",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">New guidance article</h1>
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
                placeholder="Write the article."
                className="block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Add guidance article
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
      </main>
    </div>
  );
}
