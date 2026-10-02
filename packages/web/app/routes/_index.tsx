import { Link, redirect } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { HowDocoWorks } from "~/components/how-doco-works";
import { getCurrentPrincipal } from "~/lib/session.server";
import { TAGLINE } from "~/lib/tagline";

/**
 * Host home for signed-out visitors: the logo, the headline, Get started, and
 * How Doco works. The instructions for agents live at /agents. Signed in, a
 * person's home is their workspaces, so "/" sends them there.
 */
export async function loader({ request }: { request: Request }) {
  let signedIn = false;
  try {
    signedIn = Boolean(await getCurrentPrincipal(request));
  } catch (error) {
    console.warn("Home session lookup failed; showing the signed-out home.", error);
  }
  if (signedIn) throw redirect("/workspaces");
  return null;
}

export function meta() {
  return [{ title: `Doco · ${TAGLINE}` }, { name: "description", content: `${TAGLINE}.` }];
}

export default function Home() {
  return (
    <main className="px-6 py-12 md:py-16">
      <div className="mx-auto flex max-w-3xl flex-col gap-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="sr-only">Doco</h1>
          <DocoMark height={72} />
          <p className="text-2xl font-bold leading-tight md:text-3xl">{TAGLINE}</p>
          <Link
            to="/sign-up"
            className="neu-button mt-4 rounded-md bg-primary px-6 py-2.5 font-semibold text-primary-foreground hover:opacity-90"
          >
            Get started
          </Link>
          <p className="text-sm text-muted-foreground">It takes just one minute</p>
        </div>
        <HowDocoWorks />
      </div>
    </main>
  );
}
