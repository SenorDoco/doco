import { getPublicBaseUrl } from "@doco/shared";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { agentInstructions } from "~/lib/agent-instructions";

/**
 * /agents: the instructions to give an agent, with a Copy button. Every
 * pointer for agents leads here (the head's ai-instructions tag, robots.txt,
 * the discovery probes, the OAuth recipe, invite agent.txt), and the copy an
 * agent keeps in AGENTS.md is checked against this page.
 */
export function loader({ request }: { request: Request }) {
  return { instructions: agentInstructions(getPublicBaseUrl(request)) };
}

export function meta() {
  return [
    { title: "Instructions for agents · Doco" },
    { name: "description", content: "The instructions to give an agent so it uses Doco." },
  ];
}

export default function AgentsPage({ loaderData }: { loaderData: ReturnType<typeof loader> }) {
  return (
    <main className="px-6 py-12 md:py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="sr-only">Instructions for agents</h1>
        <AgentInstructionsBlock
          title="To use Doco with your agent(s), give them these instructions:"
          instructions={loaderData.instructions}
        />
      </div>
    </main>
  );
}
