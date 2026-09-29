// Gate for the hosted MCP endpoint at `/mcp`. It establishes WHO is calling;
// the session's reach is whatever the token grants. Every tool call replays the
// bearer to the per-Doco routes, which enforce the token's grant (any set of
// workspaces and Docos, or the actor "all workspaces" mode, capped at its role)
// on top of the human's own live access. So every kind of token takes the same
// path here.
//
// The gate returns a discriminated result rather than throwing, so the route
// can shape the right transport response (401 + WWW-Authenticate).

import { getOauthTokenForRequest } from "./doco-access.server";
import { getCurrentPrincipalAsync } from "./session.server";

export interface McpContext {
  principalId: string;
}

export type McpGate =
  | { ok: true; ctx: McpContext }
  | { ok: false; kind: "unauthenticated"; message: string };

export async function gateUserMcp(request: Request): Promise<McpGate> {
  const principal = await getCurrentPrincipalAsync(request);
  if (!principal) return { ok: false, kind: "unauthenticated", message: "Unauthorized" };

  // The endpoint is bearer-only: identity comes from the access token, never a
  // cookie session.
  const token = await getOauthTokenForRequest(request);
  if (!token) return { ok: false, kind: "unauthenticated", message: "Unauthorized" };

  return { ok: true, ctx: { principalId: principal.id } };
}
