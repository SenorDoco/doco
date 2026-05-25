// GET /api/v1/agent-bootstrap.json — agent-facing bootstrap manifest.
//
// Returns the policies the caller has read-or-above access to:
//   - doco_policies[]: every Doco the agent can read (direct owner,
//     org-membership-inherited, doco_users grant, public visibility)
//
// Each policy set exposes two arrays: `guidance_policies` (prose, no automated check) and
// `neuron_authoring_policies` (rules evaluated at capture time).
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

import { getDocoByIdOrHandle, listAllDocos, withClient } from "@doco/db";
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
  /** The one-line rule statement (column renamed from `summary` to
   *  `policy` by migration 038). */
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
  neuron_authoring_policies: PolicyArticle[];
}

export async function loader({ request }: { request: Request }) {
  // Project-token bearers get a focused bootstrap: principal=null,
  // oauth_grant=null, a project_token_grant marker, and policies for
  // the single Doco the token is scoped to. This is the read-only
  // committed-credential path — distinct from the per-user OAuth flow.
  const projectToken = await getProjectTokenFromRequest(request);
  if (projectToken) {
    const docoPolicies = await loadDocoPoliciesForProjectToken(projectToken);
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
    });
  }

  const me = await getCurrentPrincipalAsync(request);
  const oauthGrant = await getOauthTokenForRequest(request);

  const docoPolicies = await loadDocoPoliciesForPrincipal(me?.id ?? null, oauthGrant);

  return Response.json({
    principal: me ? { id: me.id, username: me.username } : null,
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
  });
}

async function getProjectTokenFromRequest(request: Request): Promise<ProjectToken | null> {
  const bearer = extractBearer(request);
  if (!bearer || !isProjectToken(bearer)) return null;
  return await validateProjectToken(bearer);
}

async function loadDocoPoliciesForProjectToken(token: ProjectToken): Promise<DocoPolicySet[]> {
  const d = await getDocoByIdOrHandle(token.doco_id);
  if (!d) return [];
  const [guidance, nodeAuthoring] = await withClient((c) =>
    Promise.all([
      c.query<{ id: string; policy: string; lifecycle: string | null; body_md: string | null }>(
        `SELECT id, policy, lifecycle, body_md
           FROM guidance_policies
          WHERE doco_id = $1
            AND COALESCE(lifecycle, 'active') = 'active'
          ORDER BY created_at DESC`,
        [d.id],
      ),
      c.query<{ id: string; policy: string; lifecycle: string | null; body_md: string | null }>(
        `SELECT id, policy, lifecycle, body_md
           FROM neuron_authoring_policies
          WHERE doco_id = $1
            AND COALESCE(lifecycle, 'active') = 'active'
          ORDER BY created_at DESC`,
        [d.id],
      ),
    ]),
  );
  if (guidance.rows.length === 0 && nodeAuthoring.rows.length === 0 && d.goal.length === 0) {
    return [];
  }
  return [
    {
      doco_id: d.id,
      doco_handle: d.handle,
      goal: d.goal,
      owner_id: d.owner_id,
      guidance_policies: guidance.rows,
      neuron_authoring_policies: nodeAuthoring.rows,
    },
  ];
}

async function loadDocoPoliciesForPrincipal(
  principalId: string | null,
  oauthGrant: ValidAccessToken | null,
): Promise<DocoPolicySet[]> {
  const all = await listAllDocos();
  const out: DocoPolicySet[] = [];
  for (const d of all) {
    const meta = { ownerId: d.owner_id, visibility: d.visibility, docoId: d.id };
    // OAuth-bearer callers: token's per-Doco or per-org grant must
    // cover this Doco. Cookie callers fall through to the principal-
    // level check below.
    if (oauthGrant && !oauthTokenGrantsDoco(oauthGrant, meta)) continue;
    if (!(await canAccessDoco(meta, principalId))) continue;
    const [guidance, nodeAuthoring] = await withClient((c) =>
      Promise.all([
        c.query<{ id: string; policy: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, policy, lifecycle, body_md
             FROM guidance_policies
            WHERE doco_id = $1
              AND COALESCE(lifecycle, 'active') = 'active'
            ORDER BY created_at DESC`,
          [d.id],
        ),
        c.query<{ id: string; policy: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, policy, lifecycle, body_md
             FROM neuron_authoring_policies
            WHERE doco_id = $1
              AND COALESCE(lifecycle, 'active') = 'active'
            ORDER BY created_at DESC`,
          [d.id],
        ),
      ]),
    );
    // A Doco shows up in bootstrap when it has at least one policy
    // OR a non-empty goal — the goal is itself bootstrap context, not
    // just decoration on top of policies.
    if (guidance.rows.length === 0 && nodeAuthoring.rows.length === 0 && d.goal.length === 0) {
      continue;
    }
    out.push({
      doco_id: d.id,
      doco_handle: d.handle,
      goal: d.goal,
      owner_id: d.owner_id,
      guidance_policies: guidance.rows,
      neuron_authoring_policies: nodeAuthoring.rows,
    });
  }
  return out;
}
