import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";

/**
 * GET /api/v1/agent-link/start — Begin a browser-authorization handoff.
 *
 * The agent (running anywhere with HTTP access) fetches this endpoint
 * with optional self-description query params. It gets back a
 * short-lived state nonce, a human-readable short code, and a URL the
 * project owner opens in a browser to approve.
 *
 * Why GET (not POST): conservative agent permission classifiers
 * (Claude Code auto-mode, etc.) treat outbound POSTs to external
 * hosts as state-mutating and prompt the project owner on every
 * call. Plain GETs to a known host read the same as fetching
 * /llms.txt or /robots.txt and slip through unprompted.
 *
 * Query params (all optional):
 *   ?agent_name=<runtime>     — e.g. "claude-code", "codex-web"
 *   ?hostname=<host>          — the project owner's machine name
 *
 * Output (application/json):
 *   {
 *     state_nonce: string,         // opaque, the agent polls /poll with this
 *     short_code: string,          // 8-char human-readable code
 *     authorize_url: string,       // open in the project owner's browser
 *     poll_url: string,            // GET this URL with `?state_nonce=...` to wait for approval
 *     interval_seconds: number,    // suggested poll interval
 *     expires_at: string,          // ISO timestamp; nonce stops working after this
 *   }
 *
 * No authentication required — the browser step is where the project
 * owner identifies themselves.
 */
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const agent_name = trimToLimit(url.searchParams.get("agent_name")) ?? "unknown";
  const hostname = trimToLimit(url.searchParams.get("hostname")) ?? "unknown";
  const user_agent = request.headers.get("user-agent") ?? "unknown";

  const store = TokenStore.forDoco(rootDir());
  const row = await store.issueCliAuthorization({
    cli_version: agent_name,
    cli_hostname: hostname,
    cli_user_agent: user_agent,
  });

  const origin = `${url.protocol}//${url.host}`;
  const authorize_url = `${origin}/cli/authorize?state=${encodeURIComponent(row.state_nonce)}`;
  const poll_url = `${origin}/api/v1/agent-link/poll?state_nonce=${encodeURIComponent(row.state_nonce)}`;

  return Response.json({
    state_nonce: row.state_nonce,
    short_code: row.short_code,
    authorize_url,
    poll_url,
    interval_seconds: 2,
    expires_at: row.expires_at,
  });
}

function trimToLimit(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) return trimmed.slice(0, 200);
  return trimmed;
}
