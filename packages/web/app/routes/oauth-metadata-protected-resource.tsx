// GET /.well-known/oauth-protected-resource — RFC 9728 metadata (origin root).
//
// There is no app-wide MCP resource anymore: each MCP endpoint is
// per-workspace (/<workspace-id>/mcp) with its own path-specific metadata at
// /.well-known/oauth-protected-resource/<workspace-id>/mcp. This root document
// remains for clients that probe the origin: it advertises the authorization
// server (same origin; see the RFC 8414 sibling
// /.well-known/oauth-authorization-server) and names the origin itself as the
// resource. The 401 from a workspace MCP points connectors at the
// path-specific doc, which is what actually binds a token to one workspace.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const body = {
    // No single MCP resource: MCP is per-workspace. Name the origin so the
    // document is still well-formed for clients that probe the root.
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
