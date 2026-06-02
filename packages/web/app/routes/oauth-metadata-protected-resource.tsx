// GET /.well-known/oauth-protected-resource — RFC 9728 metadata.
//
// Tells MCP clients which authorization server guards the Doco MCP
// endpoint (/mcp). A connector that gets a 401 from /mcp follows the
// WWW-Authenticate `resource_metadata` link here, then discovers the
// authorize / token / registration endpoints via the RFC 8414 sibling
// (/.well-known/oauth-authorization-server) and runs the OAuth flow.
//
// Keep the two metadata documents in lockstep: this advertises the
// resource + its authorization server(s); the 8414 doc advertises the
// server's endpoints.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const body = {
    // The protected resource identifier — the hosted MCP endpoint.
    resource: `${issuer}/mcp`,
    // The authorization server(s) that issue tokens for this resource.
    // Same origin: Doco is its own OAuth 2.1 server (see the 8414 doc).
    authorization_servers: [issuer],
    scopes_supported: ["doco"],
    // Bearer tokens are presented in the Authorization header only.
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/llms.txt`,
  };
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
