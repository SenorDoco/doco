// GET /invite/:code/agent.txt — agent-readable companion to the
// human-facing /invite/:code approve page.
//
// When a project owner pastes an invite URL into an AI agent, the
// agent needs to know what to do with it. The invite URL itself is
// browser-only — it's a human accept step. If the agent ALSO needs
// access, they run the OAuth recipe.

import { getPublicBaseUrl } from "@doco/shared";
import { AGENT_INSTRUCTIONS_PATH } from "~/lib/agent-instructions";

export function loader({
  request,
  params,
}: {
  request: Request;
  params: { code: string };
}) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const code = params.code ?? "";
  const body = [
    "DOCO INVITE URL — for agents",
    "",
    "To use Doco, follow the instructions at:",
    "",
    `    ${baseUrl}${AGENT_INSTRUCTIONS_PATH}`,
    "",
    "You landed here because someone shared a Doco invite URL with you:",
    "",
    `    ${baseUrl}/invite/${code}`,
    "",
    "The invite URL itself is BROWSER-ONLY — clicking it through a",
    "signed-in browser adds the recipient (a human) to the Doco's",
    "users. There is no programmatic /invite/<code>/redeem endpoint.",
    "",
    "TWO THINGS HAPPEN HERE:",
    "",
    "  1. The HUMAN whose Doco this is opens the invite URL above in",
    "     their browser and accepts. That's how they get added to the",
    '     Doco. (You can tell them: "open this URL, sign in, click',
    '     Accept.")',
    "",
    "  2. Separately, if YOU (the agent) also need read/write access",
    "     to the Doco, first check the repo-root .env if you are in a",
    "     Doco-tracked repository. Agents in the same local checkout",
    "     share DOCO_ACCESS there, so do not ask for approval again if",
    "     that token works. If no shared credential works, run the",
    "     standard OAuth flow — the full recipe is at:",
    "",
    `         ${baseUrl}/protocol/agent-oauth-recipe`,
    "",
    "     Recipe A (localhost-loopback OAuth) works for shell-capable",
    "     agents like Claude Code and Cursor. Recipe B (RFC 8628",
    "     Device Authorization Grant) works for chat-only agents",
    "     that can't bind a port — you show the user a short code,",
    "     they approve at /device.",
    "",
    "     When OAuth succeeds inside a repo, write DOCO_ACCESS and",
    "     DOCO_REFRESH back to that repo-root .env for other agents in",
    "     the same checkout. Never commit .env or token values; other",
    "     clones and machines create their own local credentials.",
    "",
    "PUBLIC DOCOS: if the Doco is public-visibility, anonymous reads",
    "work without auth. Try:",
    "",
    `    GET ${baseUrl}/<doco-handle>/status.json`,
    "",
    "If it returns 200, the Doco is public and you can read its",
    "pages without OAuth.",
    "",
    "Related routes:",
    "",
    `    ${baseUrl}${AGENT_INSTRUCTIONS_PATH}`,
    `    ${baseUrl}/protocol/agent-oauth-recipe`,
    `    ${baseUrl}/.well-known/oauth-authorization-server`,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
