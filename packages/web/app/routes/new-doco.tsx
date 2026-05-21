import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
import { loadHostConfig } from "~/lib/host";
import { listMyOrgs } from "~/lib/org-helpers.server";
import { ensurePersonalOrganization } from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";

/**
 * /new-doco — Step 1 of 4 in the doco creation wizard.
 *
 * Captures the org (existing or new) and the doco name. Submits via
 * method=GET so the captured values appear as URL parameters on Step
 * 2 — no DB writes happen until Step 3, so a user who clicks "back"
 * from Step 2 or Step 3 leaves no trace.
 *
 * Wizard map:
 *   /new-doco                  Step 1 · Org + Doco name (this file)
 *   /new-doco/constitution     Step 2 · About Articles of the Constitution
 *   /new-doco/template         Step 3 · Template + visibility (creates the doco)
 *   /:handle/welcome           Step 4 · How to update articles later
 */

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  await ensurePersonalOrganization(me.id, me.username);
  const orgs = await listMyOrgs(me.id);
  const url = new URL(request.url);
  return {
    me,
    orgs,
    host: await loadHostConfig(),
    prefill: {
      orgId: url.searchParams.get("org_id") ?? "",
      newOrgHandle: url.searchParams.get("new_org_handle") ?? "",
      suffix: url.searchParams.get("suffix") ?? "",
      visibility: url.searchParams.get("visibility") === "public" ? "public" : "private",
      templateHandle: url.searchParams.get("template_handle") ?? "",
    },
  };
}

export function meta() {
  return [{ title: "New doco · Step 1 of 4 · Doco" }];
}

export default function NewDocoStep1({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, orgs, prefill } = loaderData;
  const initialOrgId = prefill.orgId || orgs[0]?.id || "";
  const [orgId, setOrgId] = useState(initialOrgId);
  const [newOrgHandle, setNewOrgHandle] = useState(prefill.newOrgHandle);
  const [suffix, setSuffix] = useState(prefill.suffix);
  const isCreateNewOrg = orgId === "";
  const orgHandleDisplay = isCreateNewOrg
    ? newOrgHandle || "<org>"
    : (orgs.find((o) => o.id === orgId)?.handle ?? "<org>");

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={hostBreadcrumb({
            section: { label: "Docos", to: "/dashboard" },
            pageLabel: "New doco",
          })}
        />
        <WizardStepper current={1} />
        <Card>
          <CardHeader>
            <CardTitle>New doco</CardTitle>
          </CardHeader>
          <CardContent>
            <Form method="get" action="/new-doco/constitution" className="space-y-4">
              {prefill.templateHandle ? (
                <input type="hidden" name="template_handle" value={prefill.templateHandle} />
              ) : null}
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  1 · Organization
                </legend>
                <select
                  name="org_id"
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.handle}
                      {o.handle === me.username ? " (personal)" : ""}
                    </option>
                  ))}
                  <option value="">+ Create a new organization</option>
                </select>
                {isCreateNewOrg ? (
                  <input
                    type="text"
                    name="new_org_handle"
                    required
                    pattern="[a-z0-9][a-z0-9_-]*"
                    value={newOrgHandle}
                    onChange={(e) => setNewOrgHandle(e.target.value.toLowerCase())}
                    placeholder="Organization handle"
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                ) : null}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  2 · Doco name
                </legend>
                <input
                  type="text"
                  name="suffix"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value.toLowerCase())}
                  placeholder="bpms"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Final handle:{" "}
                  <code data-testid="handle-preview">
                    {orgHandleDisplay}-{suffix || "<suffix>"}
                  </code>
                </span>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  3 · Visibility
                </legend>
                <select
                  name="visibility"
                  defaultValue={prefill.visibility}
                  className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Private docos return 403 to non-members on both the web and the API.
                </span>
              </fieldset>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Continue →
                </button>
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
