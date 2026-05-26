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
  addOrganizationByHandle,
  ensurePersonalOrganization,
  findAvailableOrgHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session.server";

/**
 * /new-org — create an Organization (v15 single-property model).
 *
 * The Organization has one user-facing property: `handle`. The user
 * types the handle they want. On submit, if it's free, the org lands
 * at `/orgs/<handle>`. If it's taken, the form re-renders with the
 * next available suggestion (e.g. `acme-2`) and a one-click "Use
 * suggested" button (sets `accept_suggested=1` on the form submit).
 */
export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  // Backfill personal org for sign-ins that pre-date v15.
  await ensurePersonalOrganization(me.id, me.username);
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
    const { handle } = await addOrganizationByHandle({
      handle: requested,
      ownerCollaboratorId: me.id,
      autoSuffix: accept,
    });
    throw redirect(`/orgs/${handle}`);
  } catch (e) {
    if (e instanceof Response) throw e;
    const message = (e as Error).message;
    if (!accept && message.includes("already taken")) {
      const suggested = await findAvailableOrgHandle(requested);
      return {
        error: `"${requested}" is already taken. Suggested: "${suggested}".`,
        suggested,
      };
    }
    return {
      error: friendlyHandleValidationError(message, "Organization handle"),
      suggested: null,
    };
  }
}

export function meta() {
  return [{ title: "New organization · Doco" }];
}

export default function NewOrg({
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
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={hostBreadcrumb({
            section: { label: "Orgs", to: "/orgs" },
            pageLabel: "New organization",
          })}
        />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">New organization</h1>
          <p className="text-xs text-muted-foreground">
            You become the owner. The handle is the org's only public identifier.
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
                  placeholder="my-org"
                  title={HANDLE_FORMAT_HELP}
                  aria-describedby="organization-handle-help"
                  onInvalid={(event) => {
                    event.currentTarget.setCustomValidity(
                      handleValidityMessage(event.currentTarget.validity, "Organization handle"),
                    );
                  }}
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span
                  id="organization-handle-help"
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
                  Create organization
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
