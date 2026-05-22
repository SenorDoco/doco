import { getOrgRole, withClient } from "@doco/db";
import { validateRequestedDocoId as validateRequestedDocoHandle } from "@doco/shared";
// /<doco-handle>/settings — admin-only Doco settings page. Renames the
// slug, edits description + display_name, toggles visibility
// (private/public), or deletes the Doco.
//
// Delete: people only (ADR-040). Two-step confirmation — type the slug to
// activate the "Delete permanently" button. Hard-delete via ON DELETE
// CASCADE — not recoverable. Per the `settings-page-delete-doco` Intent +
// ADR.
import { Form, Link, redirect, useSearchParams } from "react-router";
import { parse as parseYaml } from "yaml";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import {
  HANDLE_FORMAT_HELP,
  HANDLE_INPUT_PATTERN,
  friendlyHandleValidationError,
  handleValidityMessage,
} from "~/lib/handle-format";
import { listOrgsOwnedOrAdminedBy } from "~/lib/host.server";
import {
  ensureDefaultsAttached,
  listPerspectivesForDoco,
  setDefaultPerspective,
} from "~/lib/perspectives.server";
import { reindex, renameDocoHandle, softDeleteDoco, updateDocoMeta } from "~/lib/redeem.server";
import { isHumanPrincipal } from "~/lib/session.server";

async function transferDocoToOrganization(opts: {
  docoId: string;
  targetOrgId: string;
}): Promise<void> {
  await withClient(async (c) => {
    const current = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM docos WHERE id = $1 LIMIT 1",
      [opts.docoId],
    );
    const rawYaml = current.rows[0]?.raw_yaml;
    if (!rawYaml) throw new Error("Doco not found.");
    const yaml = parseYaml(rawYaml) as Record<string, unknown>;
    yaml.owner_id = opts.targetOrgId;
    yaml.org_id = opts.targetOrgId;
    await c.query(
      `UPDATE docos
          SET owner_id = $2,
              org_id = $2,
              raw_yaml = $3,
              updated_at = now()
        WHERE id = $1`,
      [opts.docoId, opts.targetOrgId, JSON.stringify(yaml)],
    );
  });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { docoSlug, handle, me, meta, ownerSlug } = await loadDocoRouteForAdmin(request, params);
  await ensureDefaultsAttached(meta.docoId);
  const perspectives = await listPerspectivesForDoco(meta.docoId);
  return {
    ownerSlug,
    docoSlug,
    handle,
    docoId: meta.docoId,
    ownerId: meta.ownerId,
    description: meta.description,
    visibility: meta.visibility,
    perspectives,
    availableOwnerOrgs: me ? await listOrgsOwnedOrAdminedBy(me.id) : [],
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
  const {
    dir: oldDir,
    docoSlug,
    handle,
    me,
    meta,
    ownerSlug,
  } = await loadDocoRouteForAdmin(request, params);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  // ── Soft-delete (ADR-040: people only) ────────────────────────────
  if (intent === "delete") {
    if (!me) return { error: "Sign in to delete this Doco." };
    if (!isHumanPrincipal(me)) {
      return { error: "Per ADR-040, only human accounts can delete docos. Ask the Doco's owner." };
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
    return redirect(`/dashboard?deleted=${encodeURIComponent(handle)}`);
  }

  // ── Default perspective ───────────────────────────────────────────
  if (intent === "set-default-perspective") {
    const perspectiveId = String(form.get("perspective_id") ?? "").trim();
    if (!perspectiveId) return { error: "Choose a default perspective." };
    const result = await setDefaultPerspective({ docoId: meta.docoId, perspectiveId });
    if (!result.ok) return { error: "That perspective is not attached to this Doco." };
    return redirect(`/${handle}/settings`);
  }

  // ── Change owning organization (danger zone) ──────────────────────
  if (intent === "change-organization") {
    if (!me) return { error: "Sign in to change this Doco's organization." };
    const targetOrgId = String(form.get("target_org_id") ?? "").trim();
    if (!targetOrgId) return { error: "Choose an organization." };
    const targetRole = await getOrgRole(targetOrgId, me.id);
    if (targetRole !== "owner") {
      return { error: "Only organization owners can move a Doco into that organization." };
    }
    try {
      await transferDocoToOrganization({ docoId: meta.docoId, targetOrgId });
      await reindex(oldDir, meta.docoId);
    } catch (e) {
      return { error: `Failed to change organization: ${(e as Error).message}` };
    }
    return redirect(`/${handle}/settings`);
  }

  if (intent !== "save") return { error: `Unknown intent: ${intent}` };

  // ── Default: save edits ───────────────────────────────────────────
  const newHandle = String(form.get("doco_handle") ?? "")
    .trim()
    .toLowerCase();
  const description = String(form.get("description") ?? "");
  const visibility = (String(form.get("visibility") ?? "") as "private" | "public") || undefined;

  if (!newHandle) return { error: "Handle is required." };
  const handleError = validateRequestedDocoHandle(newHandle);
  if (handleError) {
    return { error: friendlyHandleValidationError(handleError, "Doco handle") };
  }
  if (visibility && visibility !== "private" && visibility !== "public") {
    return { error: "Visibility must be private or public." };
  }

  let finalHandle = handle;
  if (newHandle !== handle) {
    try {
      await renameDocoHandle({ oldHandle: handle, newHandle });
      finalHandle = newHandle as typeof handle;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  try {
    await updateDocoMeta({
      handle: finalHandle,
      description,
      ...(visibility ? { visibility } : {}),
    });
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(oldDir, meta.docoId);
  return redirect(`/${finalHandle}/settings`);
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Settings · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function DocoSettings({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const {
    ownerSlug,
    docoSlug,
    handle,
    description,
    visibility,
    docoId,
    ownerId,
    perspectives,
    availableOwnerOrgs,
    me,
  } = loaderData;
  const [searchParams] = useSearchParams();
  const isConfirmingDelete = searchParams.get("confirm") === "delete";
  const currentOrgOptions = availableOwnerOrgs.filter((org) => org.id !== ownerId);

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Settings" })} />
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Rename</CardTitle>
            <CardDescription>Update the Doco handle and public metadata.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="save" />
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">Handle *</span>
                <input
                  name="doco_handle"
                  required
                  pattern={HANDLE_INPUT_PATTERN}
                  defaultValue={handle}
                  title={HANDLE_FORMAT_HELP}
                  aria-describedby="doco-handle-help"
                  onInvalid={(event) => {
                    event.currentTarget.setCustomValidity(
                      handleValidityMessage(event.currentTarget.validity, "Doco handle"),
                    );
                  }}
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                />
                <span
                  id="doco-handle-help"
                  className="mt-1 block text-[11px] text-muted-foreground"
                >
                  {HANDLE_FORMAT_HELP} Renaming takes effect immediately and updates every URL.
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
                  Private docos return 404 to non-members on both the web and the API. Existence
                  isn't leaked.
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
            <CardTitle className="text-base">Default perspective</CardTitle>
            <CardDescription>Choose the overview that opens first for this Doco.</CardDescription>
          </CardHeader>
          <CardContent>
            {perspectives.length > 0 ? (
              <Form method="post" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="intent" value="set-default-perspective" />
                <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs">
                  <span className="font-semibold text-foreground">Perspective</span>
                  <select
                    name="perspective_id"
                    defaultValue={perspectives.find((p) => p.isDefault)?.id ?? perspectives[0].id}
                    className="rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                  >
                    {perspectives.map((perspective) => (
                      <option key={perspective.id} value={perspective.id}>
                        {perspective.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Save default
                </button>
              </Form>
            ) : (
              <p className="text-xs text-muted-foreground">
                No perspectives are attached to this Doco yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Doco ID</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-[11px] text-muted-foreground">
              <span className="font-mono">{docoId}</span>
            </div>
          </CardContent>
        </Card>

        {/* Danger zone — soft-delete (ADR-040: people only). */}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Organization changes can alter who has access. Deletion permanently removes this Doco
              and every entity and edge inside it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Change organization</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Move this Doco to an organization you own. The Doco handle stays the same.
                </p>
              </div>
              {currentOrgOptions.length > 0 ? (
                <Form method="post" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="intent" value="change-organization" />
                  <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs">
                    <span className="font-semibold text-foreground">Organization</span>
                    <select
                      name="target_org_id"
                      className="rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-destructive"
                    >
                      {currentOrgOptions.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.slug}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="rounded-md border border-destructive px-4 py-2 text-xs font-semibold text-destructive hover:bg-destructive/10"
                  >
                    Change organization
                  </button>
                </Form>
              ) : (
                <p className="text-xs text-muted-foreground">
                  You do not own another organization this Doco can move to.
                </p>
              )}
            </section>

            <section className="border-t border-destructive/20 pt-4">
              {!isConfirmingDelete ? (
                <Link
                  to={`/${handle}/settings?confirm=delete`}
                  className="inline-block rounded-md border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
                >
                  Delete this Doco...
                </Link>
              ) : (
                <Form method="post" className="space-y-3">
                  <input type="hidden" name="intent" value="delete" />
                  <p className="text-xs">
                    Type the Doco's slug <span className="font-mono font-semibold">{docoSlug}</span>{" "}
                    to confirm. This permanently deletes the Doco and every entity and edge inside
                    it. It cannot be undone. Per ADR-040, only people can delete docos.
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
            </section>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
