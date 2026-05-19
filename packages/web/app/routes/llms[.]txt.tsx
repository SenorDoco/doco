// /llms.txt — agent-readable entry point at the host root.
//
// Convention: https://llmstxt.org/. Served as text/plain.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `# Doco

> Doco is AI-native documentation of intents, decisions, rules, and
> actions for software projects. Every meaningful change leaves a
> trail; every user (agent or human) working in a Doco-tracked
> project follows a shared protocol.

If a user just told you something like "let's start using Doco" or
"visit doco.to and follow the wizard", you're at the right page.

## How agents authenticate (decision_01KS14CW9ZN23FF5CGG0Z7TH4G)

Doco speaks **MCP OAuth 2.1**. There is one connection path; no
DOCO_ACCESS bearer, no .env, no helper script.

1. Your runtime installs the per-Doco MCP server at:

       ${baseUrl}/mcp/<doco-handle>

   (Per-runtime install commands — Claude Code, Claude Desktop,
   ChatGPT Connectors, Codex CLI, Cursor, Gemini Code Assist, … —
   live in the AGENTS.md template the Doco's repo carries.)

2. On first use, the runtime contacts the MCP server, gets back a
   \`WWW-Authenticate: Bearer realm="doco", resource_metadata="…"\`
   challenge, and follows the metadata chain:

       ${baseUrl}/.well-known/oauth-protected-resource
       ${baseUrl}/.well-known/oauth-authorization-server

   This is the standard MCP-OAuth dance (RFC 8414 + RFC 9728).

3. The runtime registers itself dynamically (RFC 7591) at
   \`/oauth/register\`, then opens \`/oauth/authorize\` in the project
   owner's browser. The owner signs in with GitHub (existing
   /auth/github flow), picks which Docos this runtime can access,
   clicks Approve.

4. The runtime exchanges the resulting authorization code (+ PKCE
   S256 verifier) at \`/oauth/token\` for an access + refresh token
   pair, stored in its native credential store.

5. Every subsequent MCP call carries
   \`Authorization: Bearer <access_token>\`. The token expires in 1
   hour; the refresh token lasts 60 days. Revocation is at
   \`/oauth/revoke\`.

## Creating a brand-new Doco

There is no anonymous-create endpoint anymore. To create a Doco:

  1. The project owner signs in with GitHub at ${baseUrl}/sign-in.
  2. They visit ${baseUrl}/new-doco and pick a handle.
  3. After creation, they install the MCP connector at
     \`${baseUrl}/mcp/<handle>\` in their runtime — that triggers the
     OAuth flow for the agent.

## Inviting another human (or another runtime)

  1. Doco owner opens \`${baseUrl}/<handle>/invites\` and clicks
     "New invite". A 7-day single-use URL is minted.
  2. Owner shares the URL. Recipient opens it in a browser, signs in
     with GitHub, clicks Accept → \`doco_users\` row added with the
     invite's role.
  3. Recipient installs the MCP connector and OAuth-approves the
     newly-accessible Doco.

## Tools exposed by the MCP server

\`search\`, \`list_scopes\`, \`get_status\`, \`get_audit\`,
\`list_principals\`, \`capture_decision\`, \`capture_intent\`,
\`capture_action\`, \`capture_log\`, \`capture_rule\`, \`capture_eval\`,
\`capture_reference\`, \`capture_state\`, \`patch_decision\`,
\`patch_intent\`, \`patch_action\`, \`patch_rule\`, \`patch_log\`,
\`patch_reference\`, \`create_scope\`, \`activate_scope_draft\`,
\`create_invite\`.

## Resources exposed by the MCP server

  doco://protocol/canonical-instructions   the four-invariant protocol
  doco://protocol/agent-reference          long-form reference

Fetch the canonical resource once per session via MCP
\`resources/read\`; it carries the protocol every reply must follow.

## If your runtime doesn't speak MCP yet

Most agent runtimes have native MCP support in 2026 — if yours
doesn't, ask the project owner before getting clever. There is no
fallback HTTP-with-bearer path.

## Related routes

  ${baseUrl}/.well-known/oauth-authorization-server
  ${baseUrl}/.well-known/oauth-protected-resource
  ${baseUrl}/oauth/register
  ${baseUrl}/oauth/authorize
  ${baseUrl}/oauth/token
  ${baseUrl}/oauth/revoke
  ${baseUrl}/mcp/<handle>
  ${baseUrl}/new-doco
  ${baseUrl}/<handle>/invites
  ${baseUrl}/invite/<code>
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
