// /invite/<code>/agent.txt - plain-text recipe for agents redeeming a
// specific Doco invite. Humans use /invite/<code>; agents use this route
// after the landing page identifies them as non-human.
import { getPublicBaseUrl } from "@doco/shared";

import { rootDir } from "~/lib/db.server";
import { TokenStore } from "~/lib/tokens.server";

export async function loader({ request, params }: { request: Request; params: { code: string } }) {
  const code = (params.code ?? "").trim();
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const inviteUrl = code ? `${baseUrl}/invite/${code}` : `${baseUrl}/invite/<code>`;
  const redeemUrl = code
    ? `${baseUrl}/api/v1/invites/${code}/redeem.json`
    : `${baseUrl}/api/v1/invites/<code>/redeem.json`;

  let inviteStatus = "unknown";
  if (code) {
    const invite = await TokenStore.forDoco(rootDir()).findInvite(code);
    inviteStatus = invite?.status ?? "not_found";
  }

  const body = [
    "REDEEM A DOCO INVITE - for agents",
    "",
    `Invite URL: ${inviteUrl}`,
    `Invite status on this host: ${inviteStatus}`,
    "",
    "Start with connector awareness, not with a blind curl:",
    "",
    "1. Check whether your runtime already exposes the Doco connector.",
    "   Look for native Doco tools, MCP tools, or an MCP server configured at:",
    `   ${baseUrl}/mcp`,
    "",
    "2. If the connector is already installed, use it for the Doco work it supports.",
    "   If it has an invite-redeem tool, redeem this invite with that tool. If it",
    "   does not expose invite redemption yet, make the API call in step 4, then",
    "   use the connector for bootstrap/search/capture after DOCO_ACCESS is saved.",
    "",
    "3. If the connector is not installed, ask the project owner once:",
    "",
    "   \"I can redeem this Doco invite directly. I don't see the Doco connector",
    "   installed for this agent runtime. Do you want to install it for future",
    "   sessions? It takes effect on the next restart; I'll continue with the API",
    "   in this session either way. Say 'yes install' or 'no skip'.\"",
    "",
    "   If they say yes, show the install command for their runtime:",
    `   - Claude Code: claude mcp add doco ${baseUrl}/mcp`,
    `   - Claude Desktop: add {"mcpServers":{"doco":{"url":"${baseUrl}/mcp"}}}`,
    `   - Cursor: Settings -> MCP -> Add server -> ${baseUrl}/mcp`,
    `   - Generic MCP: ${baseUrl}/mcp (Streamable HTTP)`,
    "",
    "   Do not wait for a restart. Continue through the API in this session.",
    "",
    "4. Redeem the invite. This call needs no prior auth:",
    "",
    `   curl -fsS -X POST ${redeemUrl} \\`,
    "     -H 'Content-Type: application/json' \\",
    "     -d '{}'",
    "",
    "5. Read the JSON response. It carries `doco_access`, `doco_url`,",
    "   `canonical_instructions`, `scopes`, `constitution`,",
    "   `onboarding_overlay`, `next_steps_for_agent`, and `user_message_block`.",
    "",
    "6. Walk `next_steps_for_agent` top-to-bottom. In particular:",
    "   - Write DOCO_ACCESS=<doco_access> to ./.env.",
    "   - Write or preserve DOCO.md, AGENTS.md, and CLAUDE.md as instructed.",
    "   - Render `user_message_block` verbatim to the user.",
    "   - Apply `canonical_instructions` immediately from the same response.",
    "   - Do not make a follow-on /api/v1/agent-bootstrap fetch right after",
    "     redemption; the response already includes the protocol.",
    "",
    "If the invite is expired, consumed, revoked, or not_found, stop and ask for",
    "a fresh invite URL. Do not create a new Doco to replace a bad invite.",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
