// /<doco-handle>/settings — admin-only Doco settings page. Renames the
// slug, edits description + display_name, toggles visibility
// (private/public), or deletes the Doco.
//
// Delete: people only (ADR-040). Two-step confirmation — type the slug to
// activate the "Delete permanently" button. Hard-delete via ON DELETE
// CASCADE — not recoverable. Per the `settings-page-delete-doco` Intent +
// ADR.
import { Form, Link, redirect, useSearchParams } from "react-router";
import { validateDocoSlug } from "@doco/shared";
import { rootDir } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
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
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { meta, me } = await loadDocoForAdmin(request, handle);
  return {
    ownerSlug,
    docoSlug,
    handle,
    docoId: meta.docoId,
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
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { dir: oldDir, meta, me } = await loadDocoForAdmin(request, handle);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  // ── Soft-delete (ADR-040: people only) ────────────────────────────
  if (intent === "delete") {
    if (!me) return { error: "Sign in to delete this Doco." };
    if (me.type !== "person") {
      return { error: "Per ADR-040, only people can delete docos. Ask the Doco's owner." };
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
    // Leave a slug alias so the old URL keeps resolving (D-019).
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
      ...(visibility ? { visibility } : {}),
    });
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(finalDir);
  // After rename, the handle becomes `<ownerSlug>-<finalSlug>` (the
  // host-side renameDocoSlug uses that synthesis). Redirect to the
  // canonical handle URL.
  return redirect(`/${ownerSlug}-${finalSlug}/settings`);
}

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `Settings · ${params.docoId} · Doco` }];
}

export default function DocoSettings({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, handle, description, visibility, docoId, host, me } = loaderData;
  const [searchParams] = useSearchParams();
  const isConfirmingDelete = searchParams.get("confirm") === "delete";

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Settings · {handle}</CardTitle>
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
                  Lowercase kebab-case. Renaming takes effect immediately
                  and updates every URL.
                </span>
              </label>

              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">Description</span>
                <textarea
                  name="description"
                  rows={1}
                  defaultValue={description}
                  placeholder="One or two sentences describing the project."
                  style={{ fieldSizing: "content" } as Record<string, string>}
                  className="w-full resize-none overflow-hidden rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                />
              </label>

              <fieldset className="block text-xs">
                <legend className="mb-1 block font-semibold text-foreground">Visibility</legend>
                <div className="space-y-1.5">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="visibility"
                      value="private"
                      defaultChecked={visibility !== "public"}
                      className="mt-0.5"
                    />
                    <span>Private — only owner / org members can view</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="visibility"
                      value="public"
                      defaultChecked={visibility === "public"}
                      className="mt-0.5"
                    />
                    <span>Public — anyone with the URL can view</span>
                  </label>
                </div>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Private docos return 404 to non-members on both the web
                  and the API. Existence isn't leaked.
                </span>
              </fieldset>

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
                to={`/${handle}/scopes`}
                className="text-primary hover:underline"
              >
                Manage scopes →
              </Link>
              <span className="ml-2 text-muted-foreground">
                Add/edit/delete the scopes nodes live in.
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
              Deleting permanently removes this Doco and every entity,
              edge, and scope inside it. This cannot be undone. Per
              ADR-040, only people can delete docos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!isConfirmingDelete ? (
              <Link
                to={`/${handle}/settings?confirm=delete`}
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
                  to confirm. This permanently deletes the Doco and every
                  entity, edge, and scope inside it. It cannot be undone.
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
                    to={`/${handle}/settings`}
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
