import { Form, Link, redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
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

  // Bounce back to Step 1 if state is missing — every step validates
  // its own inputs so a deep-link with a half-baked URL can't slip
  // through.
  if ((!orgId && !newOrgHandle) || !suffix) {
    throw redirect("/new-doco");
  }

  const orgs = await listMyOrgs(me.id);
  const orgHandle = orgId
    ? (orgs.find((o) => o.id === orgId)?.handle ?? null)
    : newOrgHandle;

  return { me, orgId, newOrgHandle, suffix, orgHandle };
}

export function meta() {
  return [{ title: "New doco · Step 2 of 4 · Doco" }];
}

export default function NewDocoStep2({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, orgId, newOrgHandle, suffix, orgHandle } = loaderData;
  const finalHandle = `${orgHandle ?? "<org>"}-${suffix}`;
  const backHref = `/new-doco?${new URLSearchParams({
    ...(orgId ? { org_id: orgId } : {}),
    ...(newOrgHandle ? { new_org_handle: newOrgHandle } : {}),
    suffix,
  }).toString()}`;

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <WizardStepper current={2} />
        <Card>
          <CardHeader>
            <CardTitle>About the constitution of {finalHandle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p>
              Every organization and every Doco has a{" "}
              <strong>constitution</strong> — a small body of prose and rules
              that defines how nodes get authored inside it.
            </p>
            <p>
              The constitution is made up of{" "}
              <strong>Articles of the Constitution</strong>. There are two
              kinds:
            </p>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong>Guidance articles</strong> — short prose the project
                owner writes for context. AI agents read them while working;
                they aren't checked by any automated rule.
              </li>
              <li>
                <strong>Node authoring articles</strong> — rules evaluated
                when nodes are captured. They're either deterministic
                predicates ("every Decision cites at least one Intent") or
                probabilistic specs the host evaluates with an LLM.
              </li>
            </ul>
            <p>
              AI agents acting on your project are{" "}
              <strong>always exposed</strong> to these articles. Both the
              org's articles and the Doco's articles are surfaced at the top
              of every agent session, so they shape every node the agent
              proposes.
            </p>
            <p className="text-muted-foreground">
              Your new Doco starts with an empty constitution — you'll add
              articles as the project owner finds what's worth writing down.
            </p>
          </CardContent>
        </Card>

        <Form method="get" action="/new-doco/template" className="flex items-center gap-2">
          {orgId ? <input type="hidden" name="org_id" value={orgId} /> : null}
          {newOrgHandle ? (
            <input type="hidden" name="new_org_handle" value={newOrgHandle} />
          ) : null}
          <input type="hidden" name="suffix" value={suffix} />
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
