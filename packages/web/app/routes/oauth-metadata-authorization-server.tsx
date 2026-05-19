// GET /.well-known/oauth-authorization-server — RFC 8414 metadata.
//
// MCP clients (Claude Code, Cowork, ChatGPT Connectors, Codex,
// Cursor, …) discover this URL after the /mcp endpoint returns
// 401 + WWW-Authenticate. The response declares which OAuth flows
// the server supports + where to send each one.
//
// OAuth 2.1 + PKCE S256 + dynamic client registration; no implicit
// flow, no plain code_challenge_method, no password grant.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const body = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["doco"],
    service_documentation: `${issuer}/llms.txt`,
  };
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
