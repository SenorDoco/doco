import { Form, Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  HANDLE_FORMAT_HELP,
  HANDLE_INPUT_PATTERN,
  friendlyHandleValidationError,
  handleValidityMessage,
} from "~/lib/handle-format";
import { loadHostConfig } from "~/lib/host.server";
import {
  addWorkspaceByHandle,
  ensurePersonalWorkspace,
  findAvailableWorkspaceHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session.server";

/**
 * /new-workspace — create an Workspace (v15 single-property model).
 *
 * The Workspace has one user-facing property: `handle`. The user
 * types the handle they want. On submit, if it's free, the workspace lands
 * at `/workspaces/<handle>`. If it's taken, the form re-renders with the
 * next available suggestion (e.g. `acme-2`) and a one-click "Use
 * suggested" button (sets `accept_suggested=1` on the form submit).
 */
export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  // Backfill personal workspace for sign-ins that pre-date v15.
  await ensurePersonalWorkspace(me.id, me.username);
  return { me, host: await loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const form = await request.formData();
  const requested = String(form.get("handle") ?? "")
    .trim()
    .toLowerCase();
  const accept = form.get("accept_suggested") === "1";

  if (!requested) return { error: "Handle is required.", suggested: null };

  try {
    const { handle } = await addWorkspaceByHandle({
      handle: requested,
      ownerUserId: me.id,
      autoSuffix: accept,
    });
    throw redirect(`/workspaces/${handle}`);
  } catch (e) {
    if (e instanceof Response) throw e;
    const message = (e as Error).message;
    if (!accept && message.includes("already taken")) {
      const suggested = await findAvailableWorkspaceHandle(requested);
      return {
        error: `"${requested}" is already taken. Suggested: "${suggested}".`,
        suggested,
      };
    }
    return {
      error: friendlyHandleValidationError(message, "Workspace handle"),
      suggested: null,
    };
  }
}

export function meta() {
  return [{ title: "New workspace · Doco" }];
}

export default function NewWorkspace({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string; suggested?: string | null } | undefined;
}) {
  const { me } = loaderData;
  const suggested = actionData?.suggested ?? null;
  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={hostBreadcrumb({
            section: { label: "Workspaces", to: "/workspaces" },
            pageLabel: "New workspace",
          })}
        />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">New workspace</h1>
          <p className="text-xs text-muted-foreground">
            You become the owner. The handle is the workspace's only public identifier.
          </p>
        </header>
        <Card>
          <CardContent className="pt-4">
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Handle</span>
                <input
                  type="text"
                  name="handle"
                  required
                  pattern={HANDLE_INPUT_PATTERN}
                  defaultValue={suggested ?? ""}
                  placeholder="my-workspace"
                  title={HANDLE_FORMAT_HELP}
                  aria-describedby="workspace-handle-help"
                  onInvalid={(event) => {
                    event.currentTarget.setCustomValidity(
                      handleValidityMessage(event.currentTarget.validity, "Workspace handle"),
                    );
                  }}
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span
                  id="workspace-handle-help"
                  className="mt-1 block text-[11px] text-muted-foreground"
                >
                  {HANDLE_FORMAT_HELP}
                </span>
              </label>
              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Create workspace
                </button>
                {suggested ? (
                  <button
                    type="submit"
                    name="accept_suggested"
                    value="1"
                    className="neu-button rounded-md px-4 py-2 text-sm"
                  >
                    Use "{suggested}" instead
                  </button>
                ) : null}
                <Link
                  to="/dashboard"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
