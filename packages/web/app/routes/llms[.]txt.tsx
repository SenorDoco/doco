// /llms.txt — agent-readable entry point at the host root.
//
// Convention: https://llmstxt.org/. Served as text/plain.
import { getPublicBaseUrl } from "@doco/shared";

export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const body = `# Doco

> Doco is AI-native documentation of intents, decisions, rules, and
> actions for software projects. Every meaningful change leaves a
> trail; every contributor working in a Doco-tracked project follows
> a shared protocol.

If a user just told you something like "let's start using Doco" or
"visit doco.to and follow the wizard", you're at the right page.

## Agent auth in one sentence

Doco runs a standard OAuth 2.1 authorization server (RFC 8414 +
PKCE S256 + dynamic client registration). The MCP convenience layer
is currently removed, so YOU (the agent) drive the OAuth dance
directly. Pick one of two recipes depending on your runtime, both
documented step by step at:

    ${baseUrl}/protocol/agent-oauth-recipe

## Quick recipe picker

**Are you a shell-capable agent (Claude Code, Cursor, anything that
can bind a TCP port and \`open\` a browser)?**
  → Recipe A: localhost-loopback OAuth. PKCE + authorize URL + a
    tiny local listener catches the callback. Familiar pattern —
    same as \`gh auth login\`.

**Are you a chat-only or sandboxed agent (no port binding, no
process spawning)?**
  → Recipe B: Device Authorization Grant (RFC 8628). You show the
    user a short code like \`WXYZ-1234\`, they enter it at
    ${baseUrl}/device, and you poll \`${baseUrl}/oauth/token\` until they
    approve.

Both recipes give you back a \`doco_at_…\` Bearer token. After that,
every API call is:

    GET ${baseUrl}/<handle>/<endpoint>
    Authorization: Bearer doco_at_<token>

## API endpoint shapes

JSON lives under \`/api/\`. HTML pages live at the Doco root (no
\`/api/\` prefix). One exception: \`/status.json\` lives at the root
for backwards compat.

  GET  ${baseUrl}/<handle>/status.json              # counts + freshness
  GET  ${baseUrl}/<handle>/api/<type>.json          # list nodes of that type
  POST ${baseUrl}/<handle>/api/<type>.json          # capture a new one (need 'author' role)
  GET  ${baseUrl}/<handle>/api/<type>/<id>.json     # fetch one node
  PATCH ${baseUrl}/<handle>/api/<type>/<id>.json    # update fields (need 'author' role)
  GET  ${baseUrl}/<handle>/api/<type>.txt           # plain-text spec for the body shape

Node types: \`decisions\`, \`rules\`, \`intents\`, \`actions\`,
\`logs\`, \`evals\`, \`references\`, \`states\`, \`scopes\`,
\`principals\`, \`invites\`, \`audit\`.

## Public Doco reads (no auth)

Public Docos accept anonymous reads. If your project owner tells you
the Doco is public, skip OAuth entirely and use the same endpoints
above without an Authorization header. They return 200 for public
Docos and 403 for private ones.

## Invite URLs are human-only

If a project owner pastes you a URL like \`${baseUrl}/invite/<code>\`,
that URL is for a human to open in their browser, sign in, and
accept. Don't try to POST/redeem it from agent code.

If you (the agent) need access, run the OAuth recipe above. The
human approves your access at \`${baseUrl}/device\` (Recipe B) or in
the authorize browser tab (Recipe A).

## Related routes

    ${baseUrl}/sign-in
    ${baseUrl}/new-doco
    ${baseUrl}/.well-known/oauth-authorization-server
    ${baseUrl}/protocol/canonical-instructions
    ${baseUrl}/protocol/agent-oauth-recipe
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
