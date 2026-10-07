import { Link, redirect } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { HowDocoWorks } from "~/components/how-doco-works";
import { PageMain } from "~/components/page-main";
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
    <PageMain className="pb-16">
      {/* Alexander, 2026-10-02: the same visible gap (96px) between the
          header and the logo, the headline and Get started, and Get started
          and How Doco works. Each margin is 96px less the air its element
          already shows: 4px atop the logo's artwork, the headline's line
          box below its text, and the caption's below "minute". */}
      <div className="flex flex-col items-center text-center">
        <h1 className="sr-only">Doco</h1>
        <DocoMark height={72} raised className="mt-23" />
        <p className="mt-3 text-2xl font-bold leading-tight md:text-3xl">{TAGLINE}</p>
        <Link
          to="/sign-up"
          className="neu-button mt-22 rounded-md bg-primary px-6 py-2.5 font-semibold text-primary-foreground hover:opacity-90"
        >
          Get started
        </Link>
        <p className="mt-2 text-sm text-muted-foreground">It takes just one minute</p>
        <div className="mt-22.5 w-full">
          <HowDocoWorks />
        </div>
      </div>
    </PageMain>
  );
}
