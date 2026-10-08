import { getPublicBaseUrl } from "@doco/shared";
import { Link } from "react-router";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
import { PageMain } from "~/components/page-main";
import { agentConnectGuides } from "~/lib/agent-connect-guides";
import { AGENT_INSTRUCTIONS_PATH } from "~/lib/agent-instructions";

/**
 * /agents/connect: how to connect Doco to Claude Code, Codex or Gemini CLI,
 * the agents Doco supports for now. An agent whose Doco tools are missing
 * follows its steps here itself, so the page needs no sign-in; `?agent=<id>`
 * opens one agent's steps.
 */
export function loader({ request }: { request: Request }) {
  return {
    guides: agentConnectGuides(getPublicBaseUrl(request)),
    agent: new URL(request.url).searchParams.get("agent"),
  };
}

export function meta() {
  return [
    { title: "Connect Doco to your agent · Doco" },
    {
      name: "description",
      content: "Step-by-step instructions for adding Doco to Claude Code, Codex and Gemini CLI.",
    },
  ];
}

export default function ConnectAgentPage({
  loaderData,
}: {
  loaderData: ReturnType<typeof loader>;
}) {
  return (
    <PageMain className="space-y-8 py-12 md:py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Connect Doco to your agent</h1>
        <p className="text-sm text-muted-foreground">
          Doco works with Claude Code, Codex and Gemini CLI for now. Your agent reads and writes
          Doco through Doco's MCP server, and adds it to itself with these steps when its
          instructions ask; you sign in to Doco once, and choose what the agent may reach.
        </p>
      </header>
      <ConnectAgentGuide guides={loaderData.guides} initial={loaderData.agent} />
      <p className="text-sm text-muted-foreground">
        Once it's connected, give your agent{" "}
        <Link to={AGENT_INSTRUCTIONS_PATH}>the instructions for agents</Link>.
      </p>
    </PageMain>
  );
}
