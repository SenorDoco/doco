import { Link, redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
import { loadDocoForRead } from "~/lib/doco-access.server";

/**
 * /:handle/welcome — Step 4 of 4 in the doco creation wizard.
 *
 * Reached only after Step 3 creates the doco. Explains that the
 * project owner can update the Articles of the Constitution any time,
 * at both the org and the Doco level. The "Continue to your doco"
 * link drops the project owner onto /:handle.
 */

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const handle = params.docoId;
  const { me, canonicalHandle } = await loadDocoForRead(request, handle, "reader");
  if (!me) throw redirect(`/sign-in?next=%2F${canonicalHandle}%2Fwelcome`);
  return { me, handle: canonicalHandle };
}

export function meta({ params }: { params: { docoId: string } }) {
  return [{ title: `Welcome to ${params.docoId} · Step 4 of 4 · Doco` }];
}

export default function NewDocoStep4({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, handle } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <WizardStepper current={4} />
        <Card>
          <CardHeader>
            <CardTitle>{handle} is ready.</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p>
              Your Doco is live. AI agents joining it now see an empty
              constitution — no Articles of the Constitution yet, so nothing
              constrains how they author nodes.
            </p>
            <p>
              You can change that <strong>any time</strong>. Two places to
              author Articles of the Constitution:
            </p>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <Link
                  to={`/${handle}/constitution`}
                  className="text-primary underline"
                >
                  This Doco's constitution
                </Link>{" "}
                — articles that apply only to {handle}.
              </li>
              <li>
                The owning org's constitution — articles there apply to{" "}
                <em>every</em> Doco the org owns. Visit the org page from
                the dashboard to author them.
              </li>
            </ul>
            <p className="text-muted-foreground">
              Authoring rules can block, warn, or just log when a node
              violates them. Guidance articles are prose for context —
              agents read them, no automated check.
            </p>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Link
            to={`/${handle}`}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Continue to your doco →
          </Link>
          <Link
            to={`/${handle}/constitution`}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Open the constitution page
          </Link>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}
