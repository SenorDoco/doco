// GET /.well-known/oauth-protected-resource/<workspace-id>/mcp — RFC 9728
// metadata for ONE workspace's MCP endpoint.
//
// Each workspace MCP is its own protected resource. A connector that gets a
// 401 from /<workspace-id>/mcp follows the WWW-Authenticate `resource_metadata`
// link here, learns the authorization server (same origin; see the RFC 8414
// doc at /.well-known/oauth-authorization-server), and runs the OAuth flow —
// binding the resulting token to this one workspace.

export function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceId?: string };
}) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const workspaceId = params.workspaceId ?? "";
  const body = {
    // The protected resource identifier — this workspace's MCP endpoint.
    resource: `${issuer}/${workspaceId}/mcp`,
    // Doco is its own OAuth 2.1 server (see the 8414 doc).
    authorization_servers: [issuer],
    scopes_supported: ["doco"],
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
