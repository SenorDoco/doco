// Agent self-identity — powers GET /api/v1/whoami.json and the
// "Authenticated as @username, with these levels of access" block the
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
import { getCurrentPrincipalAsync } from "~/lib/session.server";
import { rankOf } from "~/lib/user-invite";

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
  type: "person" | "agent";
  grants: IdentityGrant[];
}

export async function loadAgentIdentity(request: Request): Promise<AgentIdentity | null> {
  const me = await getCurrentPrincipalAsync(request);
  if (!me) return null;

  const token = await getOauthTokenForRequest(request);
  // loadScopeOptions returns every org/doco the principal can reach plus
  // the role they hold there — the upper bound on what any of their
  // tokens can grant.
  const options = await loadScopeOptions(me.id);

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

  return { user_id: me.id, username: me.username, type: me.type, grants };
}
