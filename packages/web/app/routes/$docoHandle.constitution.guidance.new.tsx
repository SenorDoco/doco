// /<doco-handle>/constitution/guidance/new — standalone form for
// authoring a Doco-level guidance article. Prose-only meta-rule; no
// automated check. The landing page at /<doco>/constitution links
// here from the "Add guidance article" button.

import { Form, Link, redirect, useActionData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { captureGuidanceArticle } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
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
  const docoDir = docoPath(handle);
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

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `New guidance article · ${params.docoId} · Doco` }];
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
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">New guidance article</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A plain-English rule you want everyone working on this doco to follow. Nothing checks it
            automatically — it's a shared agreement.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Article</CardTitle>
            <CardDescription>
              Summary appears in the list view; body is the full text everyone reads.
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
                  placeholder="Prefer concrete examples over abstract prose."
                  className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Body
                </span>
                <textarea
                  name="body_md"
                  rows={10}
                  placeholder="Markdown body. Rationale, examples of compliance, examples of violation."
                  className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                />
              </label>
              <div className="flex items-center gap-3 pt-2">
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
