import { redirect } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { HowDocoWorks } from "~/components/how-doco-works";
import { getCurrentPrincipal } from "~/lib/session.server";
import { TAGLINE } from "~/lib/tagline";

/**
 * Host home for signed-out visitors: the logo and the headline fill most of
 * the first screen, with How Doco works a scroll below. The instructions for
 * agents live at /agents. Signed in, a person's home is their workspaces, so
 * "/" sends them there.
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
    <main className="px-6 pb-16">
      <div className="mx-auto flex max-w-3xl flex-col">
        {/* 80% of what shows under the 3.5rem header for the logo and the
            headline, the other 20% for How Doco works' title alone: its
            steps and dial are a scroll away. */}
        <div className="flex min-h-[calc((100svh-3.5rem)*0.8)] flex-col items-center justify-center gap-3 text-center">
          <h1 className="sr-only">Doco</h1>
          <DocoMark height={72} />
          <p className="text-2xl font-bold leading-tight md:text-3xl">{TAGLINE}</p>
        </div>
        <HowDocoWorks titleClassName="min-h-[calc((100svh-3.5rem)*0.2)]" />
      </div>
    </main>
  );
}
