// POST /oauth/register — RFC 7591 dynamic client registration.
//
// Any MCP client (Claude Code, Cursor, …) that discovered our
// authorization server via /.well-known/oauth-authorization-server
// POSTs here to mint a `client_id`. The response carries the bare
// minimum: client_id + registered_at. No client_secret — OAuth 2.1
// public clients use PKCE, not secrets.
//
// Open registration is intentional: any caller can register. The
// authorization step (where the user picks which Docos to grant)
// is what gates access — registration just declares "this runtime
// exists with these redirect URIs."

import { OauthError, registerClient } from "~/lib/oauth-server.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (e) {
    return jsonError("invalid_request", `body parse failed: ${(e as Error).message}`, 400);
  }
  const redirect_uris = body.redirect_uris;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return jsonError("invalid_redirect_uri", "redirect_uris required (non-empty array)", 400);
  }
  try {
    const row = await registerClient({
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: redirect_uris as string[],
      software_id: typeof body.software_id === "string" ? body.software_id : undefined,
      software_version: typeof body.software_version === "string" ? body.software_version : undefined,
    });
    return Response.json(
      {
        client_id: row.client_id,
        client_id_issued_at: Math.floor(row.registered_at.getTime() / 1000),
        client_name: row.client_name,
        redirect_uris: row.redirect_uris,
        grant_types: row.grant_types,
        response_types: row.response_types,
        token_endpoint_auth_method: row.token_endpoint_auth_method,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof OauthError) {
      return jsonError(e.code, e.message, 400);
    }
    return jsonError("server_error", (e as Error).message, 500);
  }
}

export function loader() {
  return jsonError("invalid_request", "POST a JSON body with redirect_uris to register a client.", 405);
}

function jsonError(error: string, error_description: string, status: number): Response {
  return Response.json({ error, error_description }, { status });
}
