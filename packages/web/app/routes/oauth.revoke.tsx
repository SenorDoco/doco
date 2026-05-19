// POST /oauth/revoke — RFC 7009 token revocation.
//
// Idempotent: revoking a non-existent or already-revoked token still
// returns 200. The token_type_hint is advisory; we try both
// access-token and refresh-token tables.

import { revokeToken } from "~/lib/oauth-server.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("POST required", { status: 405 });
  }
  const form = await readBody(request);
  const token = form.get("token");
  const hint = form.get("token_type_hint");
  if (!token) {
    return Response.json({ error: "invalid_request", error_description: "token required" }, { status: 400 });
  }
  await revokeToken(
    token,
    hint === "access_token" || hint === "refresh_token" ? hint : undefined,
  );
  return new Response(null, { status: 200 });
}

async function readBody(request: Request): Promise<URLSearchParams> {
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

export function loader() {
  return new Response("POST required", { status: 405 });
}
