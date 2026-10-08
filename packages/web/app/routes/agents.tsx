import { getPublicBaseUrl } from "@doco/shared";
import { Link } from "react-router";
import { AgentInstructionsBlock, CopyButton } from "~/components/agent-instructions-block";
import { PageMain } from "~/components/page-main";
import { CONNECT_AGENT_PATH, agentInstructions } from "~/lib/agent-instructions";
import { hookInstallSnippets } from "~/lib/doco-hook-install";

/**
 * /agents: the instructions to give an agent, with a Copy button, and how to
 * install the Doco hook, which loads them at the start of every session. Every
 * pointer for agents leads here (the head's ai-instructions tag, robots.txt,
 * the discovery probes, the OAuth recipe, invite agent.txt).
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
    <PageMain className="space-y-12 py-12 md:py-16">
      <h1 className="sr-only">Instructions for agents</h1>
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Doco works with Claude Code, Codex and Gemini CLI for now. Your agent connects itself to
          Doco as <Link to={CONNECT_AGENT_PATH}>Connect Doco to your agent</Link> shows; you sign in
          once.
        </p>
        <AgentInstructionsBlock
          title="To use Doco with your agent(s), give them these instructions:"
          instructions={loaderData.instructions}
        />
      </div>
      <section id="hook" className="flex min-w-0 flex-col gap-4">
        <h2 className="text-sm font-semibold">Then install the Doco hook:</h2>
        <p className="text-sm text-muted-foreground">
          One script loads these instructions and the workspace's standing orders at session start
          (its charter, rules, Docos and what changed since the last session), then briefs the agent
          before each prompt and each file edit, with the reminder line first. So the project keeps
          no copy of the instructions, only its workspace&apos;s URL in <code>.doco/workspace</code>
          . It reads the token from <code>.doco/hook-tokens.json</code>, where the agent saves the
          token Doco&apos;s <code>doco_hook_token</code> tool gives it, kept out of git: the token
          reads what you can read in the workspace, as you. Without a token, the hook tells the
          agent to get it; when it cannot reach Doco, the agent gets the reminder alone.
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
    </PageMain>
  );
}
