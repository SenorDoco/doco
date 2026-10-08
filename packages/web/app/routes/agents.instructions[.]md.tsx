// GET /agents/instructions.md: the instructions for agents as plain text,
// which the Doco hook (app/hook/doco-hook.mjs) loads at the start of every
// session, so no project keeps a copy. Public, like /agents.
import { getPublicBaseUrl } from "@doco/shared";
import { agentInstructions } from "~/lib/agent-instructions";

export function loader({ request }: { request: Request }) {
  return new Response(agentInstructions(getPublicBaseUrl(request)), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}
