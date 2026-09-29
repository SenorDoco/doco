// GET /.well-known/oauth-authorization-server — RFC 8414 metadata.
//
// Standard OAuth 2.1 server discovery. Declares the authorize / token /
// registration / revocation endpoints, PKCE S256, dynamic client
// registration, and the supported grant types.
//
// The MCP-specific protected-resource sibling
// (/.well-known/oauth-protected-resource) is gone for now — re-add
// when the MCP server comes back.

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const body = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    // RFC 8628 Device Authorization Grant — for agents that can't
    // bind a port for the localhost-redirect flow.
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["doco"],
    service_documentation: `${issuer}/`,
  };
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
