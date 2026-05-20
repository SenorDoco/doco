// /llms.txt — agent-readable entry point at the host root.
//
// Convention: https://llmstxt.org/. Served as text/plain.
import { getPublicBaseUrl } from "@doco/shared";

export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `# Doco

> Doco is AI-native documentation of intents, decisions, rules, and
> actions for software projects. Every meaningful change leaves a
> trail; every contributor working in a Doco-tracked project follows
> a shared protocol.

If a user just told you something like "let's start using Doco" or
"visit doco.to and follow the wizard", you're at the right page.

## Current state: human-only collaboration

Programmatic agent access (MCP connector) is being rebuilt and is
not available right now. The host runs the standard OAuth 2.1
authorization server (PKCE S256, dynamic client registration), but
without the MCP layer there is no first-class agent install flow.

For now:

  - A human collaborator signs in at ${baseUrl}/sign-in with GitHub.
  - They create or join Docos via the web UI.
  - They share Decisions / Rules / Intents with you by reading them
    aloud, or by sharing the public URL of a public Doco.

If a project owner pastes a Doco invite URL to you, the URL is
human-only — they should open it in their own browser.

## Public Doco reads (anonymous)

Public Docos accept anonymous reads. If your project owner tells you
the Doco is public, fetch:

    GET ${baseUrl}/<doco-handle>/                  # the Doco home
    GET ${baseUrl}/<doco-handle>/status.json       # counts + freshness
    GET ${baseUrl}/<doco-handle>/<type>/<id>       # individual node

These return 200 for public Docos and 403 for private ones.

## When MCP comes back

The plan is to re-introduce an MCP connector layer that runtimes
install per Doco. At that point the OAuth flow becomes connector-
driven (the runtime hits ${baseUrl}/.well-known/oauth-authorization-server
and does the standard handshake). The discovery prose will live here
when that ships.

## Related routes

    ${baseUrl}/sign-in
    ${baseUrl}/new-doco
    ${baseUrl}/.well-known/oauth-authorization-server
    ${baseUrl}/protocol/canonical-instructions
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
