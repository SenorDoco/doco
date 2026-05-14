import { Form, Link, redirect } from "react-router";
import { createDocoInHost } from "@doco/host";
import { reindex } from "@doco/index";
import { rootDir } from "~/lib/db.server";
import { listOrgsOwnedOrAdminedBy, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  const orgs = await listOrgsOwnedOrAdminedBy(me.id);
  return { me, orgs, host: await loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  const form = await request.formData();
  const ownerSlug = String(form.get("owner_slug") ?? "").trim();
  const docoSlug = String(form.get("doco_slug") ?? "").trim().toLowerCase();
  const description = String(form.get("description") ?? "").trim();
  const visibility = String(form.get("visibility") ?? "private") as "private" | "public";

  if (!ownerSlug || !docoSlug) return { error: "Owner and Doco slug are required." };
  if (ownerSlug !== me.username) {
    const allowed = (await listOrgsOwnedOrAdminedBy(me.id)).find((o) => o.slug === ownerSlug);
    if (!allowed) return { error: `You can't create Docos under "${ownerSlug}".` };
  }
  try {
    const rec = await createDocoInHost(rootDir(), {
      ownerSlug,
      docoSlug,
      ...(description ? { description } : {}),
      visibility,
    });
    // Build an empty per-Doco index so the web's loaders can read it.
    await reindex(rec.path);
    // Render the success step inline so the user gets explicit "Doco
    // created" confirmation before being pushed to scope setup (ADR-080
    // rev 2 — scopes are the explicit second step but skippable).
    return { ok: { ownerSlug, docoSlug } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function meta() {
  return [{ title: "New Doco · Doco" }];
}

export default function NewDoco({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?:
    | { error?: string; ok?: { ownerSlug: string; docoSlug: string } }
    | undefined;
}) {
  const { me, orgs, host } = loaderData;
  const owners = [
    { slug: me.username, label: `${me.username} (you)`, kind: "principal" as const },
    ...orgs.map((o) => ({ slug: o.slug, label: `${o.slug} (org)`, kind: "organization" as const })),
  ];

  if (actionData?.ok) {
    const { ownerSlug, docoSlug } = actionData.ok;
    return (
      <div>
        <SiteHeader mode="host" me={me} />
        <main className="mx-auto max-w-2xl px-6 py-8 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                Doco created · {ownerSlug}/{docoSlug}
              </CardTitle>
              <CardDescription>
                Set up the scopes you'll document in. At least one scope is
                needed before nodes can be added — but you can come back any
                time.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <Link
                to={`/${ownerSlug}/${docoSlug}/scopes/new`}
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Set up scopes →
              </Link>
              <Link
                to={`/${ownerSlug}/${docoSlug}`}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Skip for now
              </Link>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-2xl px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>New Doco</CardTitle>
            <CardDescription>
              Create a new Doco owned by you or one of your organizations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Owner</span>
                <select
                  name="owner_slug"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  {owners.map((o) => (
                    <option key={o.slug} value={o.slug}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Slug</span>
                <input
                  type="text"
                  name="doco_slug"
                  required
                  pattern="[a-z0-9_-]+"
                  autoFocus
                  placeholder="my-doco"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Lowercase kebab-case. URL becomes /&lt;owner&gt;/&lt;slug&gt;.
                </span>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Description (optional)</span>
                <textarea
                  name="description"
                  rows={3}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Visibility</span>
                <select
                  name="visibility"
                  defaultValue="private"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground">
                Next step after creation: set up the scopes you want to document
                in. You can also add scopes later.
              </p>
              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Create Doco
                </button>
                <Link to="/dashboard" className="text-xs text-muted-foreground hover:text-foreground">
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
