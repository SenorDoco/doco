import { getPublicBaseUrl } from "@doco/shared";
import { AgentInstructionsBlock, CopyButton } from "~/components/agent-instructions-block";
import { agentInstructions } from "~/lib/agent-instructions";
import { hookInstallSnippets } from "~/lib/doco-hook-install";

/**
 * /agents: the instructions to give an agent, with a Copy button. Every
 * pointer for agents leads here (the head's ai-instructions tag, robots.txt,
 * the discovery probes, the OAuth recipe, invite agent.txt), and an agent
 * without Doco's connector checks its AGENTS.md copy against this page.
 */
export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  return { instructions: agentInstructions(baseUrl), hook: hookInstallSnippets(baseUrl) };
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
      <div className="mx-auto max-w-3xl space-y-12">
        <h1 className="sr-only">Instructions for agents</h1>
        <AgentInstructionsBlock
          title="To use Doco with your agent(s), give them these instructions:"
          instructions={loaderData.instructions}
        />
        <section id="hook" className="flex min-w-0 flex-col gap-4">
          <h2 className="text-sm font-semibold">Then install the Doco hook:</h2>
          <p className="text-sm text-muted-foreground">
            One script loads the workspace's standing orders at session start (its charter, rules,
            Docos and what changed since the last session), then briefs the agent before each prompt
            and each file edit, with the reminder line first. It reads the workspace from the{" "}
            <code>Doco workspace:</code> line and the token from <code>DOCO_TOKEN</code> or{" "}
            <code>.doco/project-tokens.json</code>, which a workspace owner mints under the
            workspace's settings. When it cannot reach Doco, the agent gets the reminder alone.
          </p>
          {loaderData.hook.map((snippet) => (
            <div key={snippet.title} className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-xs font-semibold text-muted-foreground">{snippet.title}</h3>
                <CopyButton text={snippet.text} />
              </div>
              <pre className="neu-well min-w-0 whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-input p-4 text-left font-mono text-xs leading-relaxed">
                {snippet.text}
              </pre>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
