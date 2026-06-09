// GET /.well-known/oauth-protected-resource — RFC 9728 metadata (origin root).
//
// The hosted MCP endpoint is `/mcp`, with its own path-specific metadata at
// /.well-known/oauth-protected-resource/mcp (the doc connectors actually
// follow from a 401). This root document remains for clients that probe the
// origin: it advertises the authorization server (same origin; see the RFC
// 8414 sibling /.well-known/oauth-authorization-server) and names the origin
// itself as the resource.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const body = {
    // Name the origin so the document is well-formed for clients that probe
    // the root; the per-endpoint doc at /…/mcp carries the MCP resource.
    resource: issuer,
    // The authorization server(s) that issue tokens. Same origin: Doco is its
    // own OAuth 2.1 server (see the 8414 doc).
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
