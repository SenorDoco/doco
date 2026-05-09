import { Form, Link, redirect } from "react-router";
import { addOrganization } from "@evalo/host";
import { rootDir, getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader({ request }: { request: Request }) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  return { me, host: loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const form = await request.formData();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const display_name = String(form.get("display_name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const visibility = String(form.get("visibility") ?? "private") as "private" | "public";
  if (!slug) return { error: "Slug is required." };
  try {
    await addOrganization(rootDir(), {
      slug,
      ...(display_name ? { display_name } : {}),
      ...(description ? { description } : {}),
      ownerUsername: me.username,
      visibility,
    });
    return redirect(`/${slug}`);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function meta() {
  return [{ title: "New organization · Evalo" }];
}

export default function NewOrg({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { me, host } = loaderData;
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} />
      <main className="mx-auto max-w-2xl px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>New organization</CardTitle>
            <CardDescription>
              You become the owner. Add members later (CLI for now;{" "}
              <code className="rounded bg-input px-1">evalo host org members add</code> coming).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Slug</span>
                <input
                  type="text"
                  name="slug"
                  required
                  pattern="[a-z0-9_-]+"
                  autoFocus
                  placeholder="my-org"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Display name (optional)</span>
                <input
                  type="text"
                  name="display_name"
                  placeholder="My Organization"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
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
                  Create organization
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
