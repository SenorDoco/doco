// /orgs/:orgHandle/constitution/guidance/new — standalone form for
// authoring an org-level guidance article. Applies to every Doco the
// org owns.

import { getOrgRole, withClient } from "@doco/db";
import { Form, Link, redirect, useActionData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { captureOrgGuidanceArticle } from "~/lib/capture.server";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipalAsync } from "~/lib/session";

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
  const summary = String(form.get("summary") ?? "").trim();
  const body_md = String(form.get("body_md") ?? "").trim();
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
          <h1 className="text-2xl font-semibold">
            New guidance article · <span className="font-mono">{org.slug}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A plain-English rule you want everyone working on this org's docos to follow. Nothing
            checks it automatically — it's a shared agreement.
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
                  placeholder="Every Doco in this org tags its bug-fix Decisions with #postmortem."
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
