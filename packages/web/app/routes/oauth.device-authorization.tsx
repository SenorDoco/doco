// POST /oauth/device_authorization — start a Device Authorization
// Grant flow (RFC 8628).
//
// For agents that can't drive a localhost-redirect OAuth flow (they
// can't bind a port, or they're not running on the same machine as
// the user's browser). The agent calls this, gets back a short
// `user_code` and a verification URL, shows them to the user, then
// polls /oauth/token with grant_type=urn:ietf:params:oauth:grant-type:device_code
// until the user approves at /device.
//
// Input (application/x-www-form-urlencoded or application/json):
//   client_id     — registered via POST /oauth/register
//   scope         — optional; we accept "doco" (default)
//
// Output (200 application/json):
//   device_code               — opaque, the agent keeps this private and polls with it
//   user_code                 — short human code (e.g. "WXYZ-1234") to show to the user
//   verification_uri          — base URL the user opens
//   verification_uri_complete — same URL with ?user_code=... prefilled
//   expires_in                — seconds until the device_code expires (default 900)
//   interval                  — seconds between polls (default 5; respect slow_down)
//
// Errors (RFC 6749 §5.2 envelope):
//   400 invalid_request  — missing/malformed client_id
//   401 invalid_client   — unknown client_id (must be registered first)

import {
  OauthError,
  createDeviceAuthorization,
} from "~/lib/oauth-server.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  const form = await readForm(request);
  const client_id = form.get("client_id");
  const scope = form.get("scope");
  if (!client_id) {
    return jsonError("invalid_request", "client_id required", 400);
  }
  try {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const payload = await createDeviceAuthorization(
      { client_id, scope: scope ?? null },
      baseUrl,
    );
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
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
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    },
  );
}
