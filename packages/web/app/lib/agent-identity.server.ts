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
  scope: "workspace" | "doco";
  id: string;
  /** Workspace handle, or `owner/handle` for a Doco. */
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
  // loadScopeOptions returns every workspace/doco the principal can reach plus
  // the role they hold there — the upper bound on what any of their
  // tokens can grant.
  const options = await loadScopeOptions(display.user_id);

  let grants: IdentityGrant[];
  // A REGULAR token is explicit-scope (any set of workspaces and Docos), so a
  // bearer request shows exactly the granted targets, capped to the token's
  // role. An ACTOR token carries no stored grants — it
  // acts as the human across their FULL membership, capped at actor_role — so
  // it takes the cookie-session path below (with the ceiling applied), letting
  // whoami / list_workspaces surface every workspace it can actually reach.
  if (token && token.grant_type !== "actor") {
    const workspaceIds = new Set(token.granted_workspace_ids ?? []);
    const docoIds = new Set(token.granted_doco_ids ?? []);
    // A Doco is in scope if granted directly OR owned by a granted Workspace
    // (a Workspace grant covers all its Docos — mirrors the access gate in
    // doco-access.server). Otherwise a Workspace-scoped token would show the
    // Workspace but hide the very Docos it can actually reach.
    grants = options
      .filter((o) =>
        o.level === "workspace"
          ? workspaceIds.has(o.id)
          : docoIds.has(o.id) || (o.workspaceId != null && workspaceIds.has(o.workspaceId)),
      )
      .map((o) => {
        // Effective (capped) role — the token can cap below the principal's
        // own. A Doco reached via a Workspace grant is capped by that
        // Workspace's role.
        let cap: DocoRole | undefined;
        if (o.level === "workspace") {
          cap = token.granted_workspace_roles?.[o.id] as DocoRole | undefined;
        } else if (docoIds.has(o.id)) {
          cap = token.granted_doco_roles?.[o.id] as DocoRole | undefined;
        } else if (o.workspaceId != null) {
          cap = token.granted_workspace_roles?.[o.workspaceId] as DocoRole | undefined;
        }
        const role = cap && rankOf(cap) < rankOf(o.myRole) ? cap : o.myRole;
        return { scope: o.level, id: o.id, label: o.label, role };
      });
  } else {
    // Cookie session, or an actor token. An actor token caps every role at its
    // actor_role ceiling (null = full owner); a cookie session is uncapped.
    const ceiling = token?.grant_type === "actor" ? token.actor_role : null;
    grants = options.map((o) => ({
      scope: o.level,
      id: o.id,
      label: o.label,
      role: ceiling && rankOf(ceiling) < rankOf(o.myRole) ? ceiling : o.myRole,
    }));
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
