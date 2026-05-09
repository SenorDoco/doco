import { Form, Link, redirect } from "react-router";
import { createEvaloInHost } from "@evalo/host";
import { reindex } from "@evalo/index";
import { rootDir, getMode } from "~/lib/db";
import { listOrgsOwnedOrAdminedBy, loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader({ request }: { request: Request }) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const orgs = listOrgsOwnedOrAdminedBy(me.id);
  return { me, orgs, host: loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const form = await request.formData();
  const ownerSlug = String(form.get("owner_slug") ?? "").trim();
  const evaloSlug = String(form.get("evalo_slug") ?? "").trim().toLowerCase();
  const description = String(form.get("description") ?? "").trim();
  const visibility = String(form.get("visibility") ?? "private") as "private" | "public";

  if (!ownerSlug || !evaloSlug) return { error: "Owner and Evalo slug are required." };
  if (ownerSlug !== me.username) {
    const allowed = listOrgsOwnedOrAdminedBy(me.id).find((o) => o.slug === ownerSlug);
    if (!allowed) return { error: `You can't create Evalos under "${ownerSlug}".` };
  }
  try {
    const rec = await createEvaloInHost(rootDir(), {
      ownerSlug,
      evaloSlug,
      ...(description ? { description } : {}),
      visibility,
    });
    // Build an empty per-Evalo index so the web's loaders can read it.
    await reindex(rec.path);
    return redirect(`/${ownerSlug}/${evaloSlug}`);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function meta() {
  return [{ title: "New Evalo · Evalo" }];
}

export default function NewEvalo({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { me, orgs, host } = loaderData;
  const owners = [
    { slug: me.username, label: `${me.username} (you)`, kind: "principal" as const },
    ...orgs.map((o) => ({ slug: o.slug, label: `${o.slug} (org)`, kind: "organization" as const })),
  ];
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} />
      <main className="mx-auto max-w-2xl px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>New Evalo</CardTitle>
            <CardDescription>
              Create a new Evalo owned by you or one of your organizations.
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
                  name="evalo_slug"
                  required
                  pattern="[a-z0-9_-]+"
                  autoFocus
                  placeholder="my-evalo"
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
              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Create Evalo
                </button>
                <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
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
