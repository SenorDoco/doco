import { getOrgRole, withClient } from "@doco/db";
import { validateRequestedDocoHandle } from "@doco/shared";
// /<doco-handle>/settings — admin-only Doco settings page. Updates Doco
// metadata or performs high-risk actions such as renaming/deleting the Doco.
//
// Delete: people only (ADR-040). Two-step confirmation — type the handle to
// activate the "Delete permanently" button. Hard-delete via ON DELETE
// CASCADE — not recoverable. Per the `settings-page-delete-doco` Intent +
// ADR.
import { Form, Link, redirect, useSearchParams } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
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
    const current = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM docos WHERE id = $1 LIMIT 1",
      [opts.docoId],
    );
    const existing = current.rows[0]?.data;
    if (!existing) throw new Error("Doco not found.");
    const yaml: Record<string, unknown> = Object.fromEntries(
      Object.entries(existing).filter(([key]) => key !== "display_name" && key !== "name"),
    );
    yaml.owner_id = opts.targetOrgId;
    yaml.org_id = opts.targetOrgId;
    await c.query(
      `UPDATE docos
          SET owner_id = $2,
              org_id = $2,
              data = $3::jsonb,
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
  const { handle, me, meta, ownerSlug } = await loadDocoRouteForAdmin(request, params);
  await ensureDefaultsAttached(meta.docoId);
  const perspectives = await listPerspectivesForDoco(meta.docoId);
  return {
    ownerSlug,
    handle,
    docoId: meta.docoId,
    ownerId: meta.ownerId,
    orgId: meta.orgId,
    visibility: meta.visibility,
    goal: meta.goal,
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
  const { handle, me, meta } = await loadDocoRouteForAdmin(request, params);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── Delete (ADR-040: people only) ─────────────────────────────────
  if (intent === "delete") {
    if (!me) return { error: "Sign in to delete this Doco." };
    if (!isHumanPrincipal(me)) {
      return { error: "Per ADR-040, only human accounts can delete docos. Ask the Doco's owner." };
    }
    const confirmHandle = String(
      form.get("confirm_handle") ?? form.get("confirm_slug") ?? "",
    ).trim();
    if (confirmHandle !== handle) {
      return {
        error: `To confirm, type the Doco handle exactly: "${handle}".`,
      };
    }
    try {
      await softDeleteDoco({ docoId: meta.docoId, handle });
    } catch (e) {
      return { error: `Failed to delete: ${(e as Error).message}` };
    }
    // The dashboard listing reads the remaining docos rows. Redirect home
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

  // ── Visibility ───────────────────────────────────────────────────
  if (intent === "update-visibility") {
    const visibility = String(form.get("visibility") ?? "") as "private" | "public";
    if (visibility !== "private" && visibility !== "public") {
      return { error: "Visibility must be private or public." };
    }
    try {
      await updateDocoMeta({ handle, visibility });
      await reindex(meta.docoId);
    } catch (e) {
      return { error: (e as Error).message };
    }
    return redirect(`/${handle}/settings`);
  }

  // ── Goal ─────────────────────────────────────────────────────────
  if (intent === "update-goal") {
    const goal = String(form.get("goal") ?? "");
    try {
      await updateDocoMeta({ handle, goal });
    } catch (e) {
      return { error: (e as Error).message };
    }
    return redirect(`/${handle}/settings`);
  }

  // ── Rename handle (danger zone) ──────────────────────────────────
  if (intent === "rename-handle") {
    const newHandle = String(form.get("doco_handle") ?? "")
      .trim()
      .toLowerCase();

    if (!newHandle) return { error: "Handle is required." };
    const handleError = validateRequestedDocoHandle(newHandle);
    if (handleError) {
      return { error: friendlyHandleValidationError(handleError, "Doco handle") };
    }
    if (newHandle === handle) return redirect(`/${handle}`);

    try {
      await renameDocoHandle({ oldHandle: handle, newHandle });
      await reindex(meta.docoId);
    } catch (e) {
      return { error: (e as Error).message };
    }
    return redirect(`/${newHandle}`);
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
      await reindex(meta.docoId);
    } catch (e) {
      return { error: `Failed to change organization: ${(e as Error).message}` };
    }
    return redirect(`/${handle}`);
  }

  return { error: `Unknown intent: ${intent}` };
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
    handle,
    visibility,
    goal,
    docoId,
    ownerId,
    orgId,
    perspectives,
    availableOwnerOrgs,
    me,
  } = loaderData;
  const [searchParams] = useSearchParams();
  const isConfirmingDelete = searchParams.get("confirm") === "delete";
  const currentOrgOptions = availableOwnerOrgs;
  const currentOrgId = orgId || ownerId;

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-5">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Settings" })} />
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

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

        <Card>
          <CardHeader>
            <CardTitle>Doco's goal</CardTitle>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="update-goal" />
              <textarea
                name="goal"
                rows={3}
                defaultValue={goal}
                placeholder="What is this doco for? Agents read this first when they bootstrap."
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
              />
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Save goal
              </button>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Visibility</CardTitle>
            <CardDescription>
              Control whether this Doco can be viewed by anyone with the URL.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="update-visibility" />
              <fieldset className="block text-xs">
                <legend className="sr-only">Visibility</legend>
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
                Save visibility
              </button>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Project tokens</CardTitle>
            <CardDescription>
              Mint a committable, read-only token so agents that clone the repo can read this Doco
              without OAuth. Only suitable when repo-readers may also be Doco-readers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to={`/${handle}/project-tokens`} className="text-sm text-primary hover:underline">
              Manage project tokens →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Default perspective</CardTitle>
            <CardDescription>Choose the overview that opens first for this Doco.</CardDescription>
          </CardHeader>
          <CardContent>
            {perspectives.length > 0 ? (
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="set-default-perspective" />
                <div className="space-y-1 text-xs">
                  <label className="inline-flex flex-col gap-1">
                    <span className="font-semibold text-foreground">Perspective</span>
                    <select
                      name="perspective_id"
                      defaultValue={
                        perspectives.find((perspective) => perspective.isDefault)?.id ??
                        perspectives[0].id
                      }
                      className="w-auto max-w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                    >
                      {perspectives.map((perspective) => (
                        <option key={perspective.id} value={perspective.id}>
                          {perspective.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Save perspective
                </button>
              </Form>
            ) : (
              <p className="text-xs text-muted-foreground">
                No perspectives are attached to this Doco yet.
              </p>
            )}
          </CardContent>
        </Card>

        <section className="space-y-1 pt-2">
          <h1 className="text-base font-semibold text-destructive">Danger zone</h1>
          <p className="text-xs text-muted-foreground">
            These changes can update every Doco URL, alter who has access, or permanently remove
            this Doco.
          </p>
        </section>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Rename handle</CardTitle>
            <CardDescription>
              Renaming takes effect immediately and updates every URL for this Doco.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="rename-handle" />
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
                  className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-destructive"
                />
                <span
                  id="doco-handle-help"
                  className="mt-1 block text-[11px] text-muted-foreground"
                >
                  {HANDLE_FORMAT_HELP}
                </span>
              </label>
              <button
                type="submit"
                className="rounded-md border border-destructive px-4 py-2 text-xs font-semibold text-destructive hover:bg-destructive/10"
              >
                Rename handle
              </button>
            </Form>
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Change organization</CardTitle>
            <CardDescription>
              Move this Doco to an organization you own. This can alter who has access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {currentOrgOptions.length > 0 ? (
              <Form method="post" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="intent" value="change-organization" />
                <label className="inline-flex flex-col gap-1 text-xs">
                  <span className="font-semibold text-foreground">Organization</span>
                  <select
                    name="target_org_id"
                    defaultValue={currentOrgId}
                    className="w-auto max-w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground outline-none focus:border-destructive"
                  >
                    {currentOrgOptions.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.handle}
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
          </CardContent>
        </Card>

        {/* Delete is ADR-040: people only. */}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Delete Doco</CardTitle>
            <CardDescription>
              Deletion permanently removes this Doco and every entity and edge inside it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!isConfirmingDelete ? (
              // Reveal the confirm form in place. preventScrollReset (mirrored
              // into history state for the main-pane restorer) keeps this
              // same-page navigation from yanking the reader to the top.
              <Link
                to={`/${handle}/settings?confirm=delete`}
                preventScrollReset
                state={{ preventScrollReset: true }}
                className="inline-block rounded-md border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
              >
                Delete this Doco...
              </Link>
            ) : (
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="delete" />
                <p className="text-xs">
                  Type the Doco handle <span className="font-mono font-semibold">{handle}</span> to
                  confirm. This permanently deletes the Doco and every entity and edge inside it. It
                  cannot be undone. Per ADR-040, only people can delete docos.
                </p>
                <input
                  name="confirm_handle"
                  required
                  autoComplete="off"
                  placeholder={handle}
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
                    preventScrollReset
                    state={{ preventScrollReset: true }}
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
