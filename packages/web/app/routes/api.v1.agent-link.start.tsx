import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";

/**
 * POST /api/v1/agent-link/start — Begin a browser-authorization handoff.
 *
 * The agent (running anywhere with HTTP access) POSTs this endpoint with
 * a self-description (name + hostname + user-agent). It gets back a
 * short-lived state nonce, a human-readable short code, and a URL the
 * project owner opens in a browser to approve.
 *
 * Input (application/json):
 *   { agent_name?: string, hostname?: string }
 *
 * Output (application/json):
 *   {
 *     state_nonce: string,         // opaque, the agent polls /poll with this
 *     short_code: string,          // 8-char human-readable code
 *     authorize_url: string,       // open in the project owner's browser
 *     poll_url: string,            // POST { state_nonce } here to wait for approval
 *     interval_seconds: number,    // suggested poll interval
 *     expires_at: string,          // ISO timestamp; nonce stops working after this
 *   }
 *
 * No authentication required — the browser step is where the project
 * owner identifies themselves.
 */
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Empty body is fine — all fields are optional.
  }

  const agent_name = stringField(body, "agent_name") ?? "unknown";
  const hostname = stringField(body, "hostname") ?? "unknown";
  const user_agent = request.headers.get("user-agent") ?? "unknown";

  const store = TokenStore.forDoco(rootDir());
  const row = await store.issueCliAuthorization({
    cli_version: agent_name,
    cli_hostname: hostname,
    cli_user_agent: user_agent,
  });

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const authorize_url = `${origin}/cli/authorize?state=${encodeURIComponent(row.state_nonce)}`;
  const poll_url = `${origin}/api/v1/agent-link/poll`;

  return Response.json({
    state_nonce: row.state_nonce,
    short_code: row.short_code,
    authorize_url,
    poll_url,
    interval_seconds: 2,
    expires_at: row.expires_at,
  });
}

export async function loader() {
  return Response.json(
    {
      error: "method_not_allowed",
      hint: "POST a JSON body to begin a browser-authorization handoff.",
    },
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
