// GET /invite/:code/agent.txt — agent-readable companion to the
// human-facing /invite/:code approve page.
//
// Why this exists: when a project owner pastes an invite URL into an
// AI agent ("let's collaborate, please redeem this URL"), the agent
// needs to know what to do with the URL. The invite URL itself is
// browser-only — it's a human accept step.

import { getPublicBaseUrl } from "@doco/shared";

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
    "You landed here because someone shared a Doco invite URL with you:",
    "",
    `    ${baseUrl}/invite/${code}`,
    "",
    "The invite URL itself is BROWSER-ONLY — clicking it through a",
    "GitHub-signed-in browser adds the recipient (a human) to the Doco's",
    "users. There is no programmatic /invite/<code>/redeem endpoint.",
    "",
    "Programmatic agent access to Doco is currently deferred — the MCP",
    "connector layer is being rebuilt. For now, you have two options:",
    "",
    "  1. Browse the Doco for context. If the Doco is public, anonymous",
    "     reads work. Try:",
    "",
    `         GET ${baseUrl}/<doco-handle>/status.json`,
    "",
    "     If it returns 200, the Doco is public and you can read its",
    "     pages without auth.",
    "",
    "  2. Ask the project owner to read you the Decisions, Rules, and",
    "     Intents you need to know about. They can navigate the Doco's",
    "     web UI directly.",
    "",
    "When programmatic agent access ships again, the relevant install",
    "URL will be advertised here.",
    "",
    "Related routes:",
    "",
    `    ${baseUrl}/llms.txt`,
    `    ${baseUrl}/.well-known/oauth-authorization-server`,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
