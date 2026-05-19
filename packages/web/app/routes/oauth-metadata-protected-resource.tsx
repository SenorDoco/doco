// GET /.well-known/oauth-protected-resource — RFC 9728 metadata.
//
// The MCP server at /mcp returns
//   WWW-Authenticate: Bearer realm="doco", resource_metadata="<this URL>"
// on unauthenticated requests. The client fetches this document to
// learn which authorization server protects the resource, then
// follows the chain to /.well-known/oauth-authorization-server.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const body = {
    resource: `${issuer}/mcp`,
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
