// /<owner>/<doco>/settings — admin-only Doco settings page. Renames the
// slug (moves the directory), edits description + display_name, toggles
// visibility (private/public), or soft-deletes the Doco.
//
// Delete: people only (ADR-040). Two-step confirmation — type the slug to
// activate the "Delete permanently" button. The Doco's directory is moved
// to `docos/<owner>/.deleted/<slug>-<timestamp>/` rather than rm-rf'd, so
// recovery is possible for some window. Per the `settings-page-delete-doco`
// Intent + ADR.
import { Form, Link, redirect, useSearchParams } from "react-router";
import { validateDocoSlug } from "@doco/shared";
import { rootDir } from "~/lib/db.server";
import { loadDocoForAdmin } from "~/lib/doco-access.server";
import { recordDocoSlugAlias } from "~/lib/doco-aliases.server";
import { loadHostConfig } from "~/lib/host";
import { reindex, renameDocoSlug, softDeleteDoco, updateDocoMeta } from "~/lib/redeem.server";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { meta, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  return {
    ownerSlug,
    docoSlug,
    docoId: meta.docoId,
    displayName: meta.displayName || docoSlug,
    description: meta.description,
    visibility: meta.visibility,
    host: await loadHostConfig(),
    me,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { dir: oldDir, meta, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  // ── Soft-delete (ADR-040: people only) ────────────────────────────
  if (intent === "delete") {
    if (!me) return { error: "Sign in to delete this Doco." };
    if (me.type !== "person") {
      return { error: "Per ADR-040, only people can delete Docos. Ask the Doco's owner." };
    }
    const confirmSlug = String(form.get("confirm_slug") ?? "").trim();
    if (confirmSlug !== docoSlug) {
      return {
        error: `To confirm, type the Doco's slug exactly: "${docoSlug}".`,
      };
    }
    try {
      await softDeleteDoco({ root: rootDir(), ownerSlug, docoSlug });
    } catch (e) {
      return { error: `Failed to delete: ${(e as Error).message}` };
    }
    // The dashboard listing already excludes `.deleted/`. Redirect home
    // with a flash-shaped query param the dashboard can surface.
    return redirect(`/dashboard?deleted=${encodeURIComponent(`${ownerSlug}/${docoSlug}`)}`);
  }

  // ── Default: save edits ───────────────────────────────────────────
  const newSlug = String(form.get("doco_slug") ?? "").trim().toLowerCase();
  const description = String(form.get("description") ?? "");
  const displayName = String(form.get("display_name") ?? "").trim();
  const visibility = (String(form.get("visibility") ?? "") as "private" | "public") || undefined;

  if (!newSlug) return { error: "Slug is required." };
  const slugError = validateDocoSlug(newSlug);
  if (slugError) return { error: slugError };
  if (visibility && visibility !== "private" && visibility !== "public") {
    return { error: "Visibility must be private or public." };
  }

  // Apply slug rename first if it changed; everything else writes to the
  // new location.
  let finalSlug = docoSlug;
  let finalDir = oldDir;
  if (newSlug !== docoSlug) {
    try {
      const { newDir } = await renameDocoSlug({
        root: rootDir(),
        ownerSlug,
        oldSlug: docoSlug,
        newSlug,
      });
      finalSlug = newSlug;
      finalDir = newDir;
    } catch (e) {
      return { error: (e as Error).message };
    }
    // Leave a slug alias so the old URL keeps resolving (D-019). Same
    // helper the claim flow uses for ownership-transfer renames.
    try {
      recordDocoSlugAlias(ownerSlug, docoSlug, ownerSlug, newSlug, meta.docoId);
    } catch (e) {
      console.error("settings: failed to record slug alias:", e);
    }
  }

  try {
    await updateDocoMeta({
      docoDir: finalDir,
      description,
      ...(displayName ? { display_name: displayName } : { display_name: null }),
      ...(visibility ? { visibility } : {}),
    });
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(finalDir);
  return redirect(`/${ownerSlug}/${finalSlug}/settings`);
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Settings · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export default function DocoSettings({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, displayName, description, visibility, docoId, host, me } = loaderData;
  const [searchParams] = useSearchParams();
  const isConfirmingDelete = searchParams.get("confirm") === "delete";

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Settings · {ownerSlug}/{docoSlug}</CardTitle>
            <CardDescription>
              Owner-only. Edit the slug, display name, description, and
              visibility. Changes apply on save; the page reloads at the
              new location if the slug changed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="save" />
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">Slug *</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{ownerSlug}/</span>
                  <input
                    name="doco_slug"
                    required
                    pattern="[a-z0-9_-]+"
                    defaultValue={docoSlug}
                    className="flex-1 rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  />
                </div>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Lowercase kebab-case. Changing this moves the Doco's
                  directory on disk and updates every URL.
                </span>
              </label>

              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">Display name</span>
                <input
                  name="display_name"
                  defaultValue={displayName}
                  placeholder={docoSlug}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>

              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">Description</span>
                <textarea
                  name="description"
                  rows={3}
                  defaultValue={description}
                  placeholder="One or two sentences describing the project."
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                />
              </label>

              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">Visibility</span>
                <select
                  name="visibility"
                  defaultValue={visibility}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="private">Private — only owner / org members can view</option>
                  <option value="public">Public — anyone with the URL can view</option>
                </select>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Private Docos return 404 to non-members on both the web
                  and the API. Existence isn't leaked.
                </span>
              </label>

              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Save settings
              </button>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Related</CardTitle>
            <CardDescription>
              Adjacent administration pages for this Doco.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <Link
                to={`/${ownerSlug}/${docoSlug}/scopes`}
                className="text-primary hover:underline"
              >
                Manage scopes →
              </Link>
              <span className="ml-2 text-muted-foreground">
                Add/edit/delete the scopes nodes live in.
              </span>
            </div>
            <div>
              <Link
                to={`/${ownerSlug}/${docoSlug}/lint`}
                className="text-primary hover:underline"
              >
                Lint →
              </Link>
              <span className="ml-2 text-muted-foreground">
                Run the connectivity + invariant checks.
              </span>
            </div>
            <div>
              <Link
                to={`/${ownerSlug}/${docoSlug}/coverage`}
                className="text-primary hover:underline"
              >
                Coverage →
              </Link>
              <span className="ml-2 text-muted-foreground">
                Drift between code changes and captured Actions (ADR-090).
              </span>
            </div>
            <div className="pt-2 text-[11px] text-muted-foreground">
              Doco id: <span className="font-mono">{docoId}</span>
            </div>
          </CardContent>
        </Card>

        {/* Danger zone — soft-delete (ADR-040: people only). */}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Deleting moves this Doco to <code>.deleted/</code> on disk —
              recoverable by hand but excluded from listings and routing.
              Per ADR-040, only people can delete Docos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!isConfirmingDelete ? (
              <Link
                to={`/${ownerSlug}/${docoSlug}/settings?confirm=delete`}
                className="inline-block rounded-md border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
              >
                Delete this Doco…
              </Link>
            ) : (
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="delete" />
                <p className="text-xs">
                  Type the Doco's slug{" "}
                  <span className="font-mono font-semibold">{docoSlug}</span>{" "}
                  to confirm. This will move it to a <code>.deleted/</code>{" "}
                  subfolder; entities and edges remain on disk but the Doco
                  disappears from all listings + URLs.
                </p>
                <input
                  name="confirm_slug"
                  required
                  autoComplete="off"
                  placeholder={docoSlug}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-destructive"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="rounded-md bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground hover:opacity-90"
                  >
                    Delete permanently
                  </button>
                  <Link
                    to={`/${ownerSlug}/${docoSlug}/settings`}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </Link>
                </div>
              </Form>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
