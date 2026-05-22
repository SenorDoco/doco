// /orgs/:orgHandle/constitution/guidance/new — standalone form for
// authoring an org-level guidance article. Applies to every Doco the
// org owns.

import { getOrgRole, withClient } from "@doco/db";
import { Form, Link, redirect, useActionData } from "react-router";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { captureOrgGuidanceArticle } from "~/lib/capture.server";
import { deriveArticleSummary } from "~/lib/constitution-copy";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

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
      `/sign-in?next=${encodeURIComponent(`/orgs/${org.slug}/constitution/guidance/new`)}`,
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
      `/sign-in?next=${encodeURIComponent(`/orgs/${org.slug}/constitution/guidance/new`)}`,
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
  const result = await captureOrgGuidanceArticle(org.id, {
    summary,
    body_md,
    authored_by_username: me.username,
    created_by_id: me.id,
  });
  if ("error" in result) return Response.json(result, { status: 400 });
  return redirect(`/orgs/${org.slug}/constitution`);
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `New guidance article · ${params.orgHandle} · Doco` }];
}

export default function NewOrgGuidanceArticle({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { org, me } = loaderData;
  const actionData = useActionData<ActionError>();
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <header>
          <Breadcrumb
            items={orgBreadcrumb({
              orgSlug: org.slug,
              parent: { label: "Constitution", to: `/orgs/${org.slug}/constitution` },
              pageLabel: "New guidance article",
            })}
            className="mb-1"
          />
          <h1 className="text-2xl font-semibold">
            New guidance article · <span className="font-mono">{org.slug}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A plain-English rule you want everyone working on this org's docos to follow. Nothing
            checks it automatically — it's a shared agreement.
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
