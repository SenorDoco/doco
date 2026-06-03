// GET /api/v1/agent-bootstrap.json — agent-facing bootstrap manifest.
//
// Returns the policies the caller has read-or-above access to:
//   - doco_policies[]: every Doco the agent can read (direct owner,
//     workspace-membership-inherited, doco_users grant, public visibility)
//   - workspace_constitutions[]: the governing charter of every Workspace the agent
//     can reach — workspaces it owns Docos in, plus workspaces granted directly
//     (OAuth workspace grant) or via membership. Always shared with agents that
//     have access to the workspace.
//
// Each policy set exposes a single `policies` array; each policy carries its
// standalone `kind` (suggestion | deterministic | probabilistic) and predicate.
//
// The project owner can add, edit, or remove policies at any time
// from /<handle>/policies — re-fetch this endpoint if you suspect
// they've changed mid-session.
//
// Auth: optional. Anonymous callers receive only public-Doco
// policies. Cookie callers receive everything they can read. OAuth-
// bearer callers receive everything the token's grants cover: Docos in
// `granted_doco_ids` and Docos owned by an
// workspace in `granted_workspace_ids`). The bootstrap response never exceeds the
// OAuth grant; an agent authorized for one workspace cannot enumerate other
// workspaces or their unrelated Docos.
//
// Bearer callers also receive an `oauth_grant` object listing the
// token's grant set verbatim — `granted_doco_ids`, `granted_workspace_ids`,
// and the per-Doco / per-workspace role caps. Agents should read it to know
// which workspaces their token already covers (workspace grants are "live": any
// Doco created under a granted workspace afterwards is automatically
// accessible — no re-auth needed). Cookie callers see `oauth_grant:
// null`.

import {
  loadBootstrapForPrincipal,
  loadBootstrapForProjectToken,
} from "~/lib/agent-bootstrap.server";
import { loadAgentDisplayIdentity } from "~/lib/agent-identity.server";
import { getOauthTokenForRequest } from "~/lib/doco-access.server";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import {
  type ProjectToken,
  isProjectToken,
  validateProjectToken,
} from "~/lib/project-tokens.server";
import { extractBearer, getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  // Project-token bearers get a focused bootstrap: principal=null,
  // oauth_grant=null, a project_token_grant marker, and policies for
  // the single Doco the token is scoped to. This is the read-only
  // committed-credential path — distinct from the per-user OAuth flow.
  const projectToken = await getProjectTokenFromRequest(request);
  if (projectToken) {
    const { docoPolicies, workspaceConstitutions } =
      await loadBootstrapForProjectToken(projectToken);
    return Response.json({
      principal: null,
      canonical_instructions_url: new URL(
        "/protocol/canonical-instructions",
        new URL(request.url).origin,
      ).toString(),
      canonical_instructions: CANONICAL_INSTRUCTIONS,
      oauth_grant: null,
      project_token_grant: {
        doco_id: projectToken.doco_id,
        role: "reader",
      },
      doco_policies: docoPolicies,
      workspace_constitutions: workspaceConstitutions,
    });
  }

  const me = await getCurrentPrincipalAsync(request);
  const principal = me ? await loadAgentDisplayIdentity(request) : null;
  const oauthGrant = await getOauthTokenForRequest(request);

  const { docoPolicies, workspaceConstitutions } = await loadBootstrapForPrincipal(
    me?.id ?? null,
    oauthGrant,
  );

  return Response.json({
    principal,
    canonical_instructions_url: new URL(
      "/protocol/canonical-instructions",
      new URL(request.url).origin,
    ).toString(),
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    oauth_grant: oauthGrant
      ? {
          client_id: oauthGrant.client_id,
          scope: oauthGrant.scope,
          granted_doco_ids: oauthGrant.granted_doco_ids,
          granted_doco_roles: oauthGrant.granted_doco_roles,
          granted_workspace_ids: oauthGrant.granted_workspace_ids,
          granted_workspace_roles: oauthGrant.granted_workspace_roles,
          expires_at: oauthGrant.expires_at.toISOString(),
        }
      : null,
    project_token_grant: null,
    doco_policies: docoPolicies,
    workspace_constitutions: workspaceConstitutions,
  });
}

async function getProjectTokenFromRequest(request: Request): Promise<ProjectToken | null> {
  const bearer = extractBearer(request);
  if (!bearer || !isProjectToken(bearer)) return null;
  return await validateProjectToken(bearer);
}
