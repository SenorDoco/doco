import { getPublicBaseUrl } from "@doco/shared";
import { redirect } from "react-router";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { DocoMark } from "~/components/doco-mark";
import { agentInstructions } from "~/lib/agent-instructions";
import { getCurrentPrincipal } from "~/lib/session.server";
import { TAGLINE } from "~/lib/tagline";

/**
 * Host home for signed-out visitors: what Doco is, and the instructions to
 * give an agent, with a Copy button. Agents read this page too; it is their
 * entry point, and the copy they keep in AGENTS.md is checked against it.
 * Signed in, a person's home is their workspaces, so "/" sends them there.
 */
export async function loader({ request }: { request: Request }) {
  let signedIn = false;
  try {
    signedIn = Boolean(await getCurrentPrincipal(request));
  } catch (error) {
    console.warn("Home session lookup failed; showing the signed-out home.", error);
  }
  if (signedIn) throw redirect("/workspaces");
  return { instructions: agentInstructions(getPublicBaseUrl(request)) };
}

export function meta() {
  return [
    { title: `Doco · ${TAGLINE}` },
    {
      name: "description",
      content: `${TAGLINE}. The instructions to give an agent are on this page.`,
    },
  ];
}

export default function Home({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { instructions } = loaderData;
  return (
    <main className="px-6 py-12 md:py-16">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="sr-only">Doco</h1>
          <DocoMark height={72} />
          <p className="text-2xl font-bold leading-tight md:text-3xl">{TAGLINE}</p>
        </div>

        <AgentInstructionsBlock
          title="To use Doco with your agent(s), give them these instructions:"
          instructions={instructions}
        />
      </div>
    </main>
  );
}
