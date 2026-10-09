import { getPublicBaseUrl } from "@doco/shared";
import { Link } from "react-router";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
import { PageMain } from "~/components/page-main";
import { agentConnectGuides } from "~/lib/agent-connect-guides";
import { AGENT_INSTRUCTIONS_PATH, MCP_PATH } from "~/lib/agent-instructions";

/**
 * /agents/connect: how a person connects Doco to Claude Code, Codex or Gemini
 * CLI, the agents Doco supports for now, in a terminal or in the agent's
 * desktop app, before inviting the agent. The page needs no sign-in and
 * shows every agent's ways and the MCP server's URL without a click;
 * `?agent=<id>` narrows it to one agent's.
 */
export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  return {
    mcp: `${baseUrl}${MCP_PATH}`,
    guides: agentConnectGuides(baseUrl),
    agent: new URL(request.url).searchParams.get("agent"),
  };
}

export function meta() {
  return [
    { title: "Connect Doco to your agent · Doco" },
    {
      name: "description",
      content:
        "Step-by-step instructions for adding Doco to Claude Code, Codex and Gemini CLI, in a terminal or in their desktop apps.",
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
          Doco through Doco's MCP server at {loaderData.mcp}. Add it to your agent with these steps,
          in a terminal or in its desktop app, and sign in to Doco once.
        </p>
      </header>
      <ConnectAgentGuide guides={loaderData.guides} initial={loaderData.agent} />
      <p className="text-sm text-muted-foreground">
        Once it's connected, ask your agent to start using Doco from your workspace's page, or give
        it <Link to={AGENT_INSTRUCTIONS_PATH}>the instructions for agents</Link>.
      </p>
    </PageMain>
  );
}
