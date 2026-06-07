// GET /.well-known/oauth-protected-resource/me/mcp — RFC 9728 metadata for the
// user-level MCP endpoint. The user variant of the per-workspace metadata: the
// protected resource is `/me/mcp` (the workspace is carried by the token, not
// the URL), pointing connectors at this same host as the OAuth 2.1 server.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  return Response.json(
    {
      resource: `${issuer}/me/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ["doco"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${issuer}/llms.txt`,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "application/json",
      },
    },
  );
}
