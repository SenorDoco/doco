// POST /oauth/token — exchange authorization code or refresh token
// for an access + refresh token pair.
//
// Per OAuth 2.1, public clients (which is what every MCP runtime is)
// supply `client_id` in the form body but no client_secret. Grant
// authentication comes from PKCE on the authorization_code grant and
// from possession of the refresh token on refresh_token grants.

import {
  OauthError,
  consumeAuthorizationCode,
  getClient,
  issueTokens,
  pollDeviceAuthorization,
  refreshTokens,
} from "~/lib/oauth-server.server";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

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
    if (grant_type === DEVICE_CODE_GRANT_TYPE) {
      return await handleDeviceCode(form);
    }
    return jsonError(
      "unsupported_grant_type",
      `grant_type must be 'authorization_code', 'refresh_token', or '${DEVICE_CODE_GRANT_TYPE}' (got ${String(grant_type)})`,
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
    user_id: claim.user_id,
    token_name: claim.token_name,
    granted_doco_ids: claim.granted_doco_ids,
    granted_doco_roles: claim.granted_doco_roles,
    granted_doco_write_types: claim.granted_doco_write_types,
    granted_workspace_ids: claim.granted_workspace_ids,
    granted_workspace_roles: claim.granted_workspace_roles,
    granted_workspace_write_types: claim.granted_workspace_write_types,
    grant_type: claim.grant_type,
    actor_role: claim.actor_role,
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

/**
 * Device Authorization Grant polling (RFC 8628 §3.4). The agent calls
 * this repeatedly until the human approves at /device. Per spec, the
 * "still waiting" responses (`authorization_pending`, `slow_down`)
 * use 400 with the OAuth error envelope — the agent inspects `error`
 * and either keeps polling at the same cadence (pending) or backs off
 * (slow_down). On success, this returns the standard token payload.
 */
async function handleDeviceCode(form: URLSearchParams): Promise<Response> {
  const device_code = required(form, "device_code");
  const client_id = required(form, "client_id");
  const client = await getClient(client_id);
  if (!client) throw new OauthError("invalid_client", "unknown client_id");
  const result = await pollDeviceAuthorization({ device_code, client_id });
  switch (result.kind) {
    case "pending":
      return jsonError(
        "authorization_pending",
        "user has not yet approved the device authorization; poll again at the advertised interval",
        400,
      );
    case "slow_down":
      return jsonError(
        "slow_down",
        "polling too fast; increase the interval by 5 seconds before the next poll",
        400,
      );
    case "denied":
      return jsonError("access_denied", "the user denied the authorization request", 400);
    case "expired":
      return jsonError(
        "expired_token",
        "device_code expired before the user approved; start a new device authorization",
        400,
      );
    case "approved":
      return Response.json(result.tokens);
  }
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
