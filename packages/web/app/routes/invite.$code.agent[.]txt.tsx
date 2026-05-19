// GET /invite/:code/agent.txt — agent-readable companion to the
// human-facing /invite/:code approve page.
//
// Why this exists: when a project owner pastes an invite URL into an
// AI agent ("let's collaborate, please redeem this URL"), the agent
// needs to know what to do with the URL. Under MCP-OAuth
// (decision_01KS14CW9ZN23FF5CGG0Z7TH4G) the invite URL itself is
// browser-only — it adds the recipient (signed-in human) to the
// Doco's users. There is no agent-side redemption endpoint anymore.
//
// This route gives the agent a clear next step instead of leaving it
// stuck staring at a URL it can't act on.

import { getDocoById } from "@doco/db";
import { getPublicBaseUrl } from "@doco/shared";
import { withClient } from "@doco/db";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { code: string };
}) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const code = params.code ?? "";

  // Try to surface the target Doco handle so the recipe can name the
  // exact MCP install URL. The invite-row lookup goes through
  // tokens_blob; we tolerate a miss and fall back to a generic prose.
  let handle = "";
  try {
    const docoId = await lookupDocoIdForInvite(code);
    if (docoId) {
      const doco = await getDocoById(docoId);
      if (doco) handle = doco.handle;
    }
  } catch {
    // soft-fail; the generic body still walks the agent through the flow
  }

  const mcpLine = handle
    ? `    ${baseUrl}/mcp/${handle}`
    : `    ${baseUrl}/mcp/<doco-handle>      (open ${baseUrl}/invite/${code} in a browser to discover the handle)`;

  const body = [
    "REDEEMING A DOCO INVITE URL — for agents",
    "",
    "You landed here because someone shared a Doco invite URL with you:",
    "",
    `    ${baseUrl}/invite/${code}`,
    "",
    "Under MCP-OAuth (decision_01KS14CW9ZN23FF5CGG0Z7TH4G), the invite URL",
    "itself is BROWSER-ONLY — clicking it through a GitHub-signed-in browser",
    "adds the recipient (a human) to the Doco's users. There is no",
    "programmatic /invite/<code>/redeem.json endpoint anymore. So:",
    "",
    "  A) If you (the agent) are running in a runtime that supports MCP",
    "     connectors (Claude Code, Claude Desktop, Claude.ai Connectors,",
    "     ChatGPT Connectors, Cursor, Codex CLI, Gemini Code Assist):",
    "",
    "     1. Tell the project owner: 'install the Doco MCP connector for",
    "        this Doco in this runtime, then approve my access in the",
    "        browser tab that opens.' The MCP install URL is:",
    "",
    mcpLine,
    "",
    "     2. The project owner runs the runtime's MCP-add command for",
    "        that URL. On first call, the runtime opens a browser tab,",
    "        the owner signs in with GitHub, picks which Doco(s) to",
    "        grant, clicks Approve.",
    "",
    "     3. Your runtime gets an OAuth access + refresh token, stored",
    "        in its native credential store. Doco tools — search,",
    "        capture_decision, list_scopes, list_principals, … — become",
    "        available natively. Done.",
    "",
    "  B) If your runtime does NOT support MCP (vanilla chat without",
    "     Connectors, etc.):",
    "",
    "     There is no path for you to authenticate directly. Tell the",
    "     project owner: 'I can't authenticate to this Doco without an",
    "     MCP-supporting runtime. Could you read me the relevant",
    "     decisions and rules from the Doco UI directly?' Or move to",
    "     a runtime that supports MCP connectors.",
    "",
    "Public Docos: if the Doco is public-visibility, anonymous reads",
    "work without auth. Try:",
    "",
    `    GET ${baseUrl}/<doco-handle>/status.json`,
    "",
    "If it returns 200 with the Doco metadata (not 403), you can read",
    "public nodes via the API even without OAuth.",
    "",
    "Related routes:",
    "",
    `    ${baseUrl}/.well-known/oauth-authorization-server`,
    `    ${baseUrl}/.well-known/oauth-protected-resource`,
    `    ${baseUrl}/llms.txt`,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Resolve the doco_id an invite code points at, by scanning
 * tokens_blob for the matching invite row. Returns null when the
 * code is unknown / expired / consumed — those cases fall through
 * to the generic body.
 */
async function lookupDocoIdForInvite(code: string): Promise<string | null> {
  if (!code) return null;
  return await withClient(async (c) => {
    const r = await c.query<{ doco_id: string }>(
      `SELECT (tok ->> 'doco_id') AS doco_id
         FROM tokens_blob
         CROSS JOIN LATERAL jsonb_array_elements(blob -> 'tokens') AS tok
        WHERE tok ->> 'kind' = 'invite'
          AND tok ->> 'code' = $1
        LIMIT 1`,
      [code],
    );
    return r.rows[0]?.doco_id ?? null;
  });
}
