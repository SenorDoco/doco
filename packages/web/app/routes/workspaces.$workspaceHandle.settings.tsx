import { getWorkspaceRole, withClient } from "@doco/db";
import { validateRequestedDocoHandle as validateRequestedWorkspaceHandle } from "@doco/shared";
import { Form, Link, redirect, useSearchParams } from "react-router";
import { Breadcrumb, workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageMain } from "~/components/page-main";
import {
  HANDLE_FORMAT_HELP,
  HANDLE_INPUT_PATTERN,
  friendlyHandleValidationError,
  handleValidityMessage,
} from "~/lib/handle-format";
import { getCurrentPrincipal } from "~/lib/session.server";

interface WorkspaceSettingsRow {
  id: string;
  handle: string;
  docoCount: number;
}

async function loadWorkspaceSettingsRow(
  workspaceHandle: string,
): Promise<WorkspaceSettingsRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<{
      id: string;
      handle: string;
      doco_count: string;
    }>(
      `SELECT id, handle,
              (
                SELECT COUNT(*)::text FROM docos d
                 WHERE d.workspace_id = workspaces.id AND d.deleted_at IS NULL
              ) AS doco_count
         FROM workspaces
        WHERE handle = $1
        LIMIT 1`,
      [workspaceHandle],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      handle: String(row.handle),
      docoCount: Number(row.doco_count),
    };
  });
}

async function requireWorkspaceOwner(request: Request, workspaceHandle: string) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  const workspace = await loadWorkspaceSettingsRow(workspaceHandle);
  if (!workspace) throw new Response(`Workspace "${workspaceHandle}" not found.`, { status: 404 });
  const role = await getWorkspaceRole(workspace.id, me.id);
  if (role !== "owner") {
    throw new Response("Only workspace owners can manage settings.", { status: 403 });
  }
  return { workspace };
}

async function renameWorkspaceHandle(opts: {
  workspaceId: string;
  currentHandle: string;
  nextHandle: string;
}): Promise<void> {
  const handleError = validateRequestedWorkspaceHandle(opts.nextHandle);
  if (handleError) throw new Error(handleError);
  if (opts.currentHandle === opts.nextHandle) return;

  await withClient(async (c) => {
    const duplicate = await c.query(
      `SELECT 1 FROM workspaces
        WHERE handle = $1 AND id <> $2
        LIMIT 1`,
      [opts.nextHandle, opts.workspaceId],
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new Error(`Workspace handle "${opts.nextHandle}" is already taken.`);
    }

    const current = await c.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE id = $1 LIMIT 1",
      [opts.workspaceId],
    );
    if ((current.rowCount ?? 0) === 0) {
      throw new Error(`Workspace "${opts.currentHandle}" not found.`);
    }

    await c.query(
      `UPDATE workspaces
          SET handle = $2,
              name = $2,
              updated_at = now()
        WHERE id = $1`,
      [opts.workspaceId, opts.nextHandle],
    );
  });
}

async function deleteWorkspaceAndDocos(workspaceId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("DELETE FROM docos WHERE workspace_id = $1", [workspaceId]);
      await c.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  return requireWorkspaceOwner(request, params.workspaceHandle);
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const { workspace } = await requireWorkspaceOwner(request, params.workspaceHandle);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "rename");

  if (intent === "delete") {
    const confirmHandle = String(form.get("confirm_handle") ?? "").trim();
    if (confirmHandle !== workspace.handle) {
      return { error: `To confirm, type the workspace handle exactly: "${workspace.handle}".` };
    }
    await deleteWorkspaceAndDocos(workspace.id);
    return redirect(`/workspaces?deleted=${encodeURIComponent(workspace.handle)}`);
  }

  if (intent !== "rename") return { error: `Unknown intent: ${intent}` };

  const nextHandle = String(form.get("workspace_handle") ?? "")
    .trim()
    .toLowerCase();
  if (!nextHandle) return { error: "Workspace handle is required." };

  try {
    await renameWorkspaceHandle({
      workspaceId: workspace.id,
      currentHandle: workspace.handle,
      nextHandle,
    });
  } catch (error) {
    return {
      error: friendlyHandleValidationError((error as Error).message, "Workspace handle"),
    };
  }

  return redirect(`/workspaces/${nextHandle}/settings`);
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `Settings · ${params.workspaceHandle} · Doco` }];
}

export default function WorkspaceSettings({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { workspace } = loaderData;
  const [searchParams] = useSearchParams();
  const isConfirmingDelete = searchParams.get("confirm") === "delete";

  return (
    <PageMain className="py-6 space-y-4">
      <Breadcrumb
        items={workspaceBreadcrumb({ workspaceSlug: workspace.handle, pageLabel: "Settings" })}
      />
      {actionData?.error ? (
        <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {actionData.error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>Rename</CardTitle>
              <CardDescription>Update the workspace handle used in URLs.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="rename" />
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-foreground">Workspace handle</span>
                  <input
                    name="workspace_handle"
                    required
                    pattern={HANDLE_INPUT_PATTERN}
                    defaultValue={workspace.handle}
                    title={HANDLE_FORMAT_HELP}
                    aria-describedby="workspace-handle-help"
                    onInvalid={(event) => {
                      event.currentTarget.setCustomValidity(
                        handleValidityMessage(event.currentTarget.validity, "Workspace handle"),
                      );
                    }}
                    onInput={(event) => event.currentTarget.setCustomValidity("")}
                    className="w-full rounded-md px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  />
                  <span
                    id="workspace-handle-help"
                    className="mt-1 block text-[11px] text-muted-foreground"
                  >
                    {HANDLE_FORMAT_HELP} Renaming takes effect immediately.
                  </span>
                </label>
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Rename workspace
                </button>
              </Form>
            </CardContent>
          </Card>
        </section>

        <aside className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Project tokens</CardTitle>
              <CardDescription>
                A committable, read-only token lets the agents that clone a repository, and the Doco
                hook, read every doco in this workspace without OAuth.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to={`/workspaces/${workspace.handle}/project-tokens`}
                className="text-sm text-primary hover:underline"
              >
                Manage project tokens →
              </Link>
            </CardContent>
          </Card>
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
              <CardDescription>
                Deleting this workspace permanently removes it and its {workspace.docoCount} doco
                {workspace.docoCount === 1 ? "" : "s"}. This cannot be undone.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!isConfirmingDelete ? (
                // Reveal the confirm form in place — preventScrollReset (mirrored
                // into history state for the main-pane restorer) keeps this
                // same-page navigation from yanking the reader to the top.
                <Link
                  to={`/workspaces/${workspace.handle}/settings?confirm=delete`}
                  preventScrollReset
                  state={{ preventScrollReset: true }}
                  className="inline-block rounded-md border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
                >
                  Delete this workspace...
                </Link>
              ) : (
                <Form method="post" className="space-y-3">
                  <input type="hidden" name="intent" value="delete" />
                  <p className="text-xs">
                    Type the workspace handle{" "}
                    <span className="font-mono font-semibold">{workspace.handle}</span> to confirm.
                  </p>
                  <input
                    name="confirm_handle"
                    required
                    autoComplete="off"
                    placeholder={workspace.handle}
                    className="w-full rounded-md px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-destructive"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      className="rounded-md bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground hover:opacity-90"
                    >
                      Delete permanently
                    </button>
                    <Link
                      to={`/workspaces/${workspace.handle}/settings`}
                      preventScrollReset
                      state={{ preventScrollReset: true }}
                      className="text-xs"
                    >
                      Cancel
                    </Link>
                  </div>
                </Form>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageMain>
  );
}
