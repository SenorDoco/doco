import { getPublicBaseUrl } from "@doco/shared";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { DocoMark } from "~/components/doco-mark";
import { agentInstructions } from "~/lib/agent-instructions";
import { TAGLINE } from "~/lib/tagline";

/**
 * Host home — the same page whether or not the visitor is signed in: what
 * Doco is, and the instructions to give an agent, with a Copy button. Agents
 * read this page too; it is their entry point, and the copy they keep in
 * AGENTS.md is checked against it.
 */
export function loader({ request }: { request: Request }) {
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
