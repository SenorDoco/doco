// Resource route — no default export. Returns the invitation manifest as JSON
// (GET) and accepts agent self-introduction as JSON (POST).
//
// Same data as the JSON-LD block embedded in the HTML page at /invite/:token,
// but available at a stable .json URL for agents that prefer pure JSON access.
import { rootDir } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { TokenStore } from "~/lib/tokens.server";
import { findPrincipalById, redeemInvitation } from "~/lib/redeem.server";
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request, params }: { request: Request; params: { token: string } }) {
  const root = rootDir();
  const host = loadHostConfig();
  const store = TokenStore.forDoco(root);
  const inv = await store.resolveInvitation(params.token);
  const baseUrl = getPublicBaseUrl(request);

  if (!inv) {
    return new Response(
      JSON.stringify(
        {
          kind: "doco_invitation",
          schema_version: "0.1",
          status: "unknown_token",
          host: { name: host.name, url: baseUrl },
          token: params.token,
          notes: [
            "This invitation token is not valid (already redeemed, expired, or unknown).",
          ],
        },
        null,
        2,
      ),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  const inviter = findPrincipalById(root, inv.inviter_id);
  return new Response(
    JSON.stringify(
      {
        kind: "doco_invitation",
        schema_version: "0.1",
        status: "open",
        host: { name: host.name, url: baseUrl },
        inviter: inviter
          ? { id: inviter.id, username: inviter.username, type: inviter.type }
          : undefined,
        token: params.token,
        expires_at: inv.expires_at,
        redeem: {
          method: "POST",
          url: `${baseUrl}/invite/${params.token}.json`,
          headers: { "content-type": "application/json" },
          body_schema: {
            display_name: "string (required) — human-friendly name for this agent",
            model: "string (recommended) — e.g. claude-opus-4-7",
            provider: "string (recommended) — e.g. anthropic",
            capabilities: "string[] (optional) — declared capabilities/tools",
          },
          example_body: {
            display_name: "my-agent",
            model: "claude-opus-4-7",
            provider: "anthropic",
          },
        },
        notes: [
          "Single-use, 5-minute Doco invitation token. Per ADR-037 + ADR-068.",
          `Redeeming creates a Principal{type: agent} owned by ${inviter?.username ?? "the inviter"}.`,
          "Response includes a long-lived session token. Store it as DOCO_TOKEN.",
        ],
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export async function action({ request, params }: { request: Request; params: { token: string } }) {
  const ct = request.headers.get("content-type") ?? "";
  let body: { display_name?: string; model?: string; provider?: string; capabilities?: string[] };
  if (ct.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as typeof body;
  } else {
    const form = await request.formData();
    body = {
      display_name: String(form.get("display_name") ?? "") || undefined,
      model: String(form.get("model") ?? "") || undefined,
      provider: String(form.get("provider") ?? "") || undefined,
    };
  }

  const result = await redeemInvitation(rootDir(), params.token, body);
  if ("error" in result) {
    const status =
      result.error.kind === "invalid_or_expired_invitation"
        ? 401
        : result.error.kind === "inviter_no_longer_exists"
          ? 410
          : 500;
    return new Response(JSON.stringify({ error: result.error }, null, 2), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(result, null, 2), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
