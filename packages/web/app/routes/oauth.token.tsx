// POST /oauth/token — exchange authorization code or refresh token
// for an access + refresh token pair.
//
// Per OAuth 2.1, public clients (which is what every MCP runtime is)
// supply `client_id` in the form body but no client_secret. Grant
// authentication comes from PKCE on the authorization_code grant and
// from possession of the refresh token on refresh_token grants.

import {
  consumeAuthorizationCode,
  getClient,
  issueTokens,
  OauthError,
  refreshTokens,
} from "~/lib/oauth-server.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  const form = await readForm(request);
  const grant_type = form.get("grant_type");
  try {
    if (grant_type === "authorization_code") {
      return await handleAuthorizationCode(form);
    }
    if (grant_type === "refresh_token") {
      return await handleRefreshToken(form);
    }
    return jsonError(
      "unsupported_grant_type",
      `grant_type must be 'authorization_code' or 'refresh_token' (got ${String(grant_type)})`,
      400,
    );
  } catch (e) {
    if (e instanceof OauthError) {
      const status = e.code === "invalid_client" ? 401 : 400;
      return jsonError(e.code, e.message, status);
    }
    return jsonError("server_error", (e as Error).message, 500);
  }
}

export function loader() {
  return jsonError("invalid_request", "POST required", 405);
}

async function handleAuthorizationCode(form: URLSearchParams): Promise<Response> {
  const code = required(form, "code");
  const client_id = required(form, "client_id");
  const redirect_uri = required(form, "redirect_uri");
  const code_verifier = required(form, "code_verifier");
  // Validate client exists; preserves invariant that revoked client
  // registrations cannot exchange codes that were issued under them.
  const client = await getClient(client_id);
  if (!client) throw new OauthError("invalid_client", "unknown client_id");
  const claim = await consumeAuthorizationCode({ code, client_id, redirect_uri, code_verifier });
  const tokens = await issueTokens({
    client_id,
    principal_id: claim.principal_id,
    granted_doco_ids: claim.granted_doco_ids,
    scope: claim.scope,
  });
  return Response.json(tokens);
}

async function handleRefreshToken(form: URLSearchParams): Promise<Response> {
  const refresh_token = required(form, "refresh_token");
  const client_id = required(form, "client_id");
  const client = await getClient(client_id);
  if (!client) throw new OauthError("invalid_client", "unknown client_id");
  const tokens = await refreshTokens({ client_id, refresh_token });
  return Response.json(tokens);
}

function required(form: URLSearchParams, key: string): string {
  const v = form.get(key);
  if (!v) throw new OauthError("invalid_request", `${key} required`);
  return v;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await request.text());
  }
  if (ct.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string") params.set(k, v);
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

function jsonError(error: string, error_description: string, status: number): Response {
  return Response.json(
    { error, error_description },
    {
      status,
      // Per RFC 6749, error responses should not be cached.
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    },
  );
}
