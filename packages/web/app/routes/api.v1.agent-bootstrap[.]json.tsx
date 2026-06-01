// GET /api/v1/agent-bootstrap.json — agent-facing bootstrap manifest.
//
// Returns the policies the caller has read-or-above access to:
//   - doco_policies[]: every Doco the agent can read (direct owner,
//     org-membership-inherited, doco_users grant, public visibility)
//   - org_constitutions[]: the governing charter of every Org the agent
//     can reach — orgs it owns Docos in, plus orgs granted directly
//     (OAuth org grant) or via membership. Always shared with agents that
//     have access to the org.
//
// Each policy set exposes two arrays: `guidance_policies` (prose, no automated check) and
// `node_authoring_policies` (rules evaluated at capture time).
//
// The project owner can add, edit, or remove policies at any time
// from /<handle>/policies — re-fetch this endpoint if you suspect
// they've changed mid-session.
//
// Auth: optional. Anonymous callers receive only public-Doco
// policies. Cookie callers receive everything they can read. OAuth-
// bearer callers receive everything the token's grants cover: Docos in
// `granted_doco_ids` and Docos owned by an
// org in `granted_org_ids`). The bootstrap response never exceeds the
// OAuth grant; an agent authorized for one org cannot enumerate other
// orgs or their unrelated Docos.
//
// Bearer callers also receive an `oauth_grant` object listing the
// token's grant set verbatim — `granted_doco_ids`, `granted_org_ids`,
// and the per-Doco / per-org role caps. Agents should read it to know
// which orgs their token already covers (org grants are "live": any
// Doco created under a granted org afterwards is automatically
// accessible — no re-auth needed). Cookie callers see `oauth_grant:
// null`.

import {
  type OrgConstitution,
  getDocoByIdOrHandle,
  getOrgConstitutionsByIds,
  listAllDocos,
  listOrganizationsForUser,
  withClient,
} from "@doco/db";
import { loadAgentDisplayIdentity } from "~/lib/agent-identity.server";
import {
  canAccessDoco,
  getOauthTokenForRequest,
  oauthTokenGrantsDoco,
} from "~/lib/doco-access.server";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import type { ValidAccessToken } from "~/lib/oauth-server.server";
import {
  type ProjectToken,
  isProjectToken,
  validateProjectToken,
} from "~/lib/project-tokens.server";
import { extractBearer, getCurrentPrincipalAsync } from "~/lib/session.server";

interface PolicyArticle {
  id: string;
  /** The one-line rule statement. */
  policy: string;
  lifecycle: string | null;
  body_md: string | null;
}

interface DocoPolicySet {
  doco_id: string;
  doco_handle: string;
  /**
   * Project-owner-authored sentence (or template-seeded default)
   * describing what this Doco is for. Rendered at the top of the
   * Doco's policy set so agents read the goal before the rules.
   * Empty string when unset.
   */
  goal: string;
  owner_id: string;
  guidance_policies: PolicyArticle[];
  node_authoring_policies: PolicyArticle[];
}

export async function loader({ request }: { request: Request }) {
  // Project-token bearers get a focused bootstrap: principal=null,
  // oauth_grant=null, a project_token_grant marker, and policies for
  // the single Doco the token is scoped to. This is the read-only
  // committed-credential path — distinct from the per-user OAuth flow.
  const projectToken = await getProjectTokenFromRequest(request);
  if (projectToken) {
    const { docoPolicies, orgConstitutions } = await loadBootstrapForProjectToken(projectToken);
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
      org_constitutions: orgConstitutions,
    });
  }

  const me = await getCurrentPrincipalAsync(request);
  const principal = me ? await loadAgentDisplayIdentity(request) : null;
  const oauthGrant = await getOauthTokenForRequest(request);

  const { docoPolicies, orgConstitutions } = await loadBootstrapForPrincipal(
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
          granted_org_ids: oauthGrant.granted_org_ids,
          granted_org_roles: oauthGrant.granted_org_roles,
          expires_at: oauthGrant.expires_at.toISOString(),
        }
      : null,
    project_token_grant: null,
    doco_policies: docoPolicies,
    org_constitutions: orgConstitutions,
  });
}

async function getProjectTokenFromRequest(request: Request): Promise<ProjectToken | null> {
  const bearer = extractBearer(request);
  if (!bearer || !isProjectToken(bearer)) return null;
  return await validateProjectToken(bearer);
}

async function loadPolicyArticles(docoId: string): Promise<{
  guidance: PolicyArticle[];
  nodeAuthoring: PolicyArticle[];
}> {
  const [guidance, nodeAuthoring] = await withClient((c) =>
    Promise.all([
      c.query<{ id: string; policy: string; lifecycle: string | null; body_md: string | null }>(
        `SELECT id, policy, lifecycle, body_md
           FROM guidance_policies
          WHERE doco_id = $1
            AND COALESCE(lifecycle, 'asserted') = 'asserted'
          ORDER BY created_at DESC`,
        [docoId],
      ),
      c.query<{ id: string; policy: string; lifecycle: string | null; body_md: string | null }>(
        `SELECT id, policy, lifecycle, body_md
           FROM node_authoring_policies
          WHERE doco_id = $1
            AND COALESCE(lifecycle, 'asserted') = 'asserted'
          ORDER BY created_at DESC`,
        [docoId],
      ),
    ]),
  );
  return { guidance: guidance.rows, nodeAuthoring: nodeAuthoring.rows };
}

async function loadBootstrapForProjectToken(
  token: ProjectToken,
): Promise<{ docoPolicies: DocoPolicySet[]; orgConstitutions: OrgConstitution[] }> {
  const d = await getDocoByIdOrHandle(token.doco_id);
  if (!d) return { docoPolicies: [], orgConstitutions: [] };
  // The token is scoped to one Doco; surface that Doco's owning org's
  // constitution alongside it.
  const orgConstitutions = await getOrgConstitutionsByIds([d.org_id]);
  const { guidance, nodeAuthoring } = await loadPolicyArticles(d.id);
  if (guidance.length === 0 && nodeAuthoring.length === 0 && d.goal.length === 0) {
    return { docoPolicies: [], orgConstitutions };
  }
  return {
    docoPolicies: [
      {
        doco_id: d.id,
        doco_handle: d.handle,
        goal: d.goal,
        owner_id: d.owner_id,
        guidance_policies: guidance,
        node_authoring_policies: nodeAuthoring,
      },
    ],
    orgConstitutions,
  };
}

async function loadBootstrapForPrincipal(
  principalId: string | null,
  oauthGrant: ValidAccessToken | null,
): Promise<{ docoPolicies: DocoPolicySet[]; orgConstitutions: OrgConstitution[] }> {
  const all = await listAllDocos();
  const docoPolicies: DocoPolicySet[] = [];
  // Every org the caller can reach. Seeded from the orgs owning accessible
  // Docos, then augmented with orgs granted directly (OAuth) or by
  // membership (cookie) — so an org granted with no Docos yet still shows.
  const orgIds = new Set<string>();
  for (const d of all) {
    const meta = { ownerId: d.owner_id, visibility: d.visibility, docoId: d.id };
    // OAuth-bearer callers: token's per-Doco or per-org grant must
    // cover this Doco. Cookie callers fall through to the principal-
    // level check below.
    if (oauthGrant && !oauthTokenGrantsDoco(oauthGrant, meta)) continue;
    if (!(await canAccessDoco(meta, principalId))) continue;
    orgIds.add(d.org_id);
    const { guidance, nodeAuthoring } = await loadPolicyArticles(d.id);
    // A Doco shows up in bootstrap when it has at least one policy
    // OR a non-empty goal — the goal is itself bootstrap context, not
    // just decoration on top of policies.
    if (guidance.length === 0 && nodeAuthoring.length === 0 && d.goal.length === 0) {
      continue;
    }
    docoPolicies.push({
      doco_id: d.id,
      doco_handle: d.handle,
      goal: d.goal,
      owner_id: d.owner_id,
      guidance_policies: guidance,
      node_authoring_policies: nodeAuthoring,
    });
  }

  if (oauthGrant) {
    for (const orgId of oauthGrant.granted_org_ids) orgIds.add(orgId);
  } else if (principalId) {
    for (const org of await listOrganizationsForUser(principalId)) orgIds.add(org.id);
  }

  const orgConstitutions = await getOrgConstitutionsByIds([...orgIds]);
  return { docoPolicies, orgConstitutions };
}
