import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";

/**
 * POST /api/v1/cli/device-init — Initiates a CLI authorization
 * (decision_01KRKZM14WNA1685GN0F12WCKM). The CLI sends its identity
 * (version + hostname + user-agent) and gets back a state nonce + short
 * code + authorize URL. The CLI opens the authorize URL in the project
 * owner's browser, then polls /api/v1/cli/device-exchange.
 *
 * Input (application/json):
 *   { cli_version: string, cli_hostname: string }
 *
 * Output (application/json):
 *   { id, state_nonce, short_code, authorize_url, expires_at }
 *
 * No authentication required — the authorize step in the browser is
 * where the project owner identifies themselves.
 */
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const cli_version = stringField(body, "cli_version") ?? "unknown";
  const cli_hostname = stringField(body, "cli_hostname") ?? "unknown";
  const cli_user_agent =
    request.headers.get("user-agent") ?? stringField(body, "cli_user_agent") ?? "unknown";

  const store = TokenStore.forDoco(rootDir());
  const row = await store.issueCliAuthorization({
    cli_version,
    cli_hostname,
    cli_user_agent,
  });

  const url = new URL(request.url);
  const authorize_url = `${url.protocol}//${url.host}/cli/authorize?state=${encodeURIComponent(row.state_nonce)}`;

  return Response.json({
    id: row.id,
    state_nonce: row.state_nonce,
    short_code: row.short_code,
    authorize_url,
    expires_at: row.expires_at,
  });
}

export async function loader() {
  return Response.json(
    { error: "method_not_allowed", hint: "POST a JSON body — see /api/v1/cli/device-init in docs." },
    { status: 405 },
  );
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) return trimmed.slice(0, 200);
  return trimmed;
}
