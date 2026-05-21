import { Form, Link, redirect } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadHostConfig } from "~/lib/host";
import {
  addOrganizationByHandle,
  ensurePersonalOrganization,
  findAvailableOrgHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";

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
      ownerPrincipalId: me.id,
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
    return { error: message, suggested: null };
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
      <SingleColumnPageMain className="py-8">
        <Card>
          <CardHeader>
            <CardTitle>New organization</CardTitle>
            <CardDescription>
              You become the owner. The handle is the org's only public identifier — your Docos
              will live at <code>/&lt;handle&gt;-&lt;doco-suffix&gt;/</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Handle</span>
                <input
                  type="text"
                  name="handle"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  autoFocus
                  defaultValue={suggested ?? ""}
                  placeholder="my-org"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Lowercase kebab-case ([a-z0-9][a-z0-9_-]*). The handle is the org's only
                  property.
                </span>
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
                {suggested ? (
                  <button
                    type="submit"
                    name="accept_suggested"
                    value="1"
                    className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
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
