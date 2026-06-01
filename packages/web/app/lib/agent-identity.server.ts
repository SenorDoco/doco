// Agent self-identity — powers GET /api/v1/whoami.json and the
// "Authenticated as <credential>, with these levels of access" block the
// MCP server renders right after a successful OAuth completion.
//
// "Levels of access" means what the *token* can touch, not the raw
// principal. For an OAuth bearer we intersect the principal's grants
// with the token's scope-down (a token can be narrower than the human
// who minted it, never wider). Cookie sessions (browser, no token)
// fall back to the principal's full membership set.

import type { DocoRole } from "@doco/db";
import { loadScopeOptions } from "~/lib/api-keys.server";
import { getOauthTokenForRequest } from "~/lib/doco-access.server";
import { type CurrentPrincipal, getCurrentPrincipalAsync } from "~/lib/session.server";
import { rankOf } from "~/lib/user-invite";
import type { ValidAccessToken } from "./oauth-server.server";

export interface IdentityGrant {
  scope: "org" | "doco";
  id: string;
  /** Org handle, or `owner/handle` for a Doco. */
  label: string;
  role: DocoRole;
}

export interface AgentIdentity {
  user_id: string;
  username: string;
  type: "person";
  credential: AgentCredentialIdentity | null;
  indicator_prefix: string;
  grants: IdentityGrant[];
}

export interface AgentCredentialIdentity {
  nickname: string;
  on_behalf_of_username: string;
  indicator_prefix: string;
}

export interface AgentDisplayIdentity {
  user_id: string;
  username: string;
  type: "person";
  credential: AgentCredentialIdentity | null;
  indicator_prefix: string;
}

export async function loadAgentDisplayIdentity(
  request: Request,
): Promise<AgentDisplayIdentity | null> {
  const me = await getCurrentPrincipalAsync(request);
  if (!me) return null;

  const token = await getOauthTokenForRequest(request);
  const credential = token ? await loadCredentialIdentity(me, token) : null;

  return {
    user_id: me.id,
    username: me.username,
    type: me.type,
    credential,
    indicator_prefix: credential?.indicator_prefix ?? `[🔮 Doco @${cleanUsername(me.username)}]`,
  };
}

export async function loadAgentIdentity(request: Request): Promise<AgentIdentity | null> {
  const display = await loadAgentDisplayIdentity(request);
  if (!display) return null;

  const token = await getOauthTokenForRequest(request);
  // loadScopeOptions returns every org/doco the principal can reach plus
  // the role they hold there — the upper bound on what any of their
  // tokens can grant.
  const options = await loadScopeOptions(display.user_id);

  let grants: IdentityGrant[];
  if (token) {
    const orgIds = new Set(token.granted_org_ids ?? []);
    const docoIds = new Set(token.granted_doco_ids ?? []);
    grants = options
      .filter(
        (o) => (o.level === "org" && orgIds.has(o.id)) || (o.level === "doco" && docoIds.has(o.id)),
      )
      .map((o) => {
        // The token may cap the role below the principal's own; show the
        // effective (lower) role so the agent sees what it can actually do.
        const cap = (
          o.level === "org" ? token.granted_org_roles?.[o.id] : token.granted_doco_roles?.[o.id]
        ) as DocoRole | undefined;
        const role = cap && rankOf(cap) < rankOf(o.myRole) ? cap : o.myRole;
        return { scope: o.level, id: o.id, label: o.label, role };
      });
  } else {
    grants = options.map((o) => ({ scope: o.level, id: o.id, label: o.label, role: o.myRole }));
  }
  grants.sort((a, b) => a.label.localeCompare(b.label));

  return { ...display, grants };
}

async function loadCredentialIdentity(
  me: CurrentPrincipal,
  token: ValidAccessToken,
): Promise<AgentCredentialIdentity> {
  const onBehalfOf = cleanUsername(me.username);
  const nickname = credentialNickname(me, token);
  return {
    nickname,
    on_behalf_of_username: onBehalfOf,
    indicator_prefix: `[🔮 Doco ${nickname} on behalf of @${cleanUsername(onBehalfOf)}]`,
  };
}

function credentialNickname(me: CurrentPrincipal, token: ValidAccessToken): string {
  // Tokens carry their own human-visible credential label. The OAuth
  // client name remains the software/app label.
  const preferred = token.token_name || token.client_name || me.username;
  return cleanIndicatorSegment(preferred || token.client_name || token.client_id.slice(0, 20));
}

function cleanUsername(value: string): string {
  return cleanIndicatorSegment(value).replace(/^@+/, "");
}

function cleanIndicatorSegment(value: string): string {
  const clean = value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\[\]\r\n]+/g, "");
  return clean || "unknown";
}
