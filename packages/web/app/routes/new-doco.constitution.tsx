import { Form, Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
import {
  AGENT_EXPOSURE_NOTE,
  GUIDANCE_ARTICLE_EXPLAINER,
  NODE_AUTHORING_ARTICLE_EXPLAINER,
} from "~/lib/constitution-copy";
import { listMyOrgs } from "~/lib/org-helpers.server";
import { getCurrentPrincipal } from "~/lib/session";

/**
 * /new-doco/constitution — Step 2 of 4.
 *
 * Read-only explanation of constitutions and Articles of the
 * Constitution. State (org_id | new_org_handle, suffix) is carried in
 * the URL from Step 1. Continue form GETs Step 3 with the same params.
 */

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");

  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id") ?? "";
  const newOrgHandle = url.searchParams.get("new_org_handle") ?? "";
  const suffix = url.searchParams.get("suffix") ?? "";
  const visibility = url.searchParams.get("visibility") === "public" ? "public" : "private";
  const templateHandle = url.searchParams.get("template_handle") ?? "";

  // Bounce back to Step 1 if state is missing — every step validates
  // its own inputs so a deep-link with a half-baked URL can't slip
  // through.
  if ((!orgId && !newOrgHandle) || !suffix) {
    throw redirect("/new-doco");
  }

  const orgs = await listMyOrgs(me.id);
  const orgHandle = orgId ? (orgs.find((o) => o.id === orgId)?.handle ?? null) : newOrgHandle;

  return { me, orgId, newOrgHandle, suffix, visibility, templateHandle, orgHandle };
}

export function meta() {
  return [{ title: "New doco · Step 2 of 4 · Doco" }];
}

export default function NewDocoStep2({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, orgId, newOrgHandle, suffix, visibility, templateHandle, orgHandle } = loaderData;
  const finalHandle = `${orgHandle ?? "<org>"}-${suffix}`;
  const backHref = `/new-doco?${new URLSearchParams({
    ...(orgId ? { org_id: orgId } : {}),
    ...(newOrgHandle ? { new_org_handle: newOrgHandle } : {}),
    suffix,
    visibility,
    ...(templateHandle ? { template_handle: templateHandle } : {}),
  }).toString()}`;

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={[
            { label: "Home", to: "/" },
            { label: "Docos", to: "/dashboard" },
            { label: "New doco", to: "/new-doco" },
            { label: "Constitution" },
          ]}
        />
        <header>
          <h1 className="text-2xl font-semibold">About the constitution of {finalHandle}</h1>
        </header>
        <WizardStepper current={2} />
        <Card>
          <CardContent className="space-y-3 text-sm">
            <p>
              A constitution defines how nodes get authored. It's made of <strong>articles</strong>{" "}
              in two kinds:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>
                <strong>Guidance articles</strong> — {GUIDANCE_ARTICLE_EXPLAINER}
              </li>
              <li>
                <strong>Node-authoring articles</strong> — {NODE_AUTHORING_ARTICLE_EXPLAINER}
              </li>
            </ul>
            <p>{AGENT_EXPOSURE_NOTE}</p>
            <p className="text-muted-foreground">
              Your new doco starts empty. Add articles as you find what's worth writing down.
            </p>
          </CardContent>
        </Card>

        <Form method="get" action="/new-doco/template" className="flex items-center gap-2">
          {orgId ? <input type="hidden" name="org_id" value={orgId} /> : null}
          {newOrgHandle ? <input type="hidden" name="new_org_handle" value={newOrgHandle} /> : null}
          <input type="hidden" name="suffix" value={suffix} />
          <input type="hidden" name="visibility" value={visibility} />
          {templateHandle ? (
            <input type="hidden" name="template_handle" value={templateHandle} />
          ) : null}
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Continue →
          </button>
          <Link
            to={backHref}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            ← Back
          </Link>
          <Link
            to="/dashboard"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Link>
        </Form>
      </SingleColumnPageMain>
    </div>
  );
}
