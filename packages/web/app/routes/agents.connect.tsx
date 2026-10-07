import { getPublicBaseUrl } from "@doco/shared";
import { Link } from "react-router";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
import { agentConnectGuides } from "~/lib/agent-connect-guides";
import { AGENT_INSTRUCTIONS_PATH } from "~/lib/agent-instructions";

/**
 * /agents/connect: how a person connects Doco to the agent they use. An agent
 * whose Doco tools are missing sends its person here, so it needs no sign-in;
 * `?agent=<id>` opens one agent's steps.
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
      content: "Step-by-step instructions for adding Doco to Claude, ChatGPT, Cursor and more.",
    },
  ];
}

export default function ConnectAgentPage({
  loaderData,
}: {
  loaderData: ReturnType<typeof loader>;
}) {
  return (
    <main className="px-6 py-12 md:py-16">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Connect Doco to your agent</h1>
          <p className="text-sm text-muted-foreground">
            Your agent reads and writes Doco through Doco's MCP server. Pick your agent and follow
            its steps; you sign in to Doco once, and choose what the agent may reach.
          </p>
        </header>
        <ConnectAgentGuide guides={loaderData.guides} initial={loaderData.agent} />
        <p className="text-sm text-muted-foreground">
          Once it's connected, give your agent{" "}
          <Link to={AGENT_INSTRUCTIONS_PATH}>the instructions for agents</Link>.
        </p>
      </div>
    </main>
  );
}
