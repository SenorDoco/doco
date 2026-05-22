// GET /api/v1/agent-bootstrap.json — agent-facing bootstrap manifest.
//
// Returns the Articles of the Constitution the caller has read-or-
// above access to, grouped by constitution:
//   - org_constitutions[]: every org the agent is a member of (any role)
//   - doco_constitutions[]: every Doco the agent can read (direct owner,
//     org-membership-inherited, doco_users grant, public visibility)
//
// Each constitution exposes two arrays of Articles of the
// Constitution: `guidance_primitives` (prose, no automated check) and
// `neuron_authoring_primitives` (rules evaluated at capture time). Org
// articles apply to every Doco the org owns, so an agent that
// bootstraps Doco-the-tool (not a single Doco) gets the full set of
// authoring rules that govern its work across every project.
//
// The project owner can add, edit, or remove articles at any time
// from /<handle>/constitution or /orgs/<org>/constitution — re-fetch
// this endpoint if you suspect they've changed mid-session.
//
// Auth: optional. Anonymous callers receive only public-Doco
// constitutions (no org constitutions, since org membership requires
// identity). Cookie callers receive everything they can read. OAuth-
// bearer callers receive everything the token's grants cover — orgs in
// `granted_org_ids` and Docos in `granted_doco_ids` (or owned by an
// org in `granted_org_ids`). The bootstrap response never exceeds the
// OAuth grant; an agent authorized for one org cannot enumerate other
// orgs the underlying principal happens to belong to.
//
// Bearer callers also receive an `oauth_grant` object listing the
// token's grant set verbatim — `granted_doco_ids`, `granted_org_ids`,
// and the per-Doco / per-org role caps. Agents should read it to know
// which orgs their token already covers (org grants are "live": any
// Doco created under a granted org afterwards is automatically
// accessible — no re-auth needed). Cookie callers see `oauth_grant:
// null`.

import { listAllDocos, withClient } from "@doco/db";
import {
  canAccessDoco,
  getOauthTokenForRequest,
  oauthTokenGrantsDoco,
} from "~/lib/doco-access.server";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import type { ValidAccessToken } from "~/lib/oauth-server.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

interface ArticleSummary {
  id: string;
  summary: string;
  lifecycle: string | null;
  body_md: string | null;
}

interface OrgConstitution {
  org_id: string;
  org_handle: string;
  org_name: string;
  guidance_primitives: ArticleSummary[];
  neuron_authoring_primitives: ArticleSummary[];
}

interface DocoConstitution {
  doco_id: string;
  doco_handle: string;
  owner_id: string;
  guidance_primitives: ArticleSummary[];
  neuron_authoring_primitives: ArticleSummary[];
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipalAsync(request);
  const oauthGrant = await getOauthTokenForRequest(request);

  const orgConstitutions: OrgConstitution[] = me
    ? await loadOrgConstitutionsForPrincipal(me.id, oauthGrant)
    : [];
  const docoConstitutions = await loadDocoConstitutionsForPrincipal(
    request,
    me?.id ?? null,
    oauthGrant,
  );

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
    org_constitutions: orgConstitutions,
    doco_constitutions: docoConstitutions,
  });
}

async function loadOrgConstitutionsForPrincipal(
  principalId: string,
  oauthGrant: ValidAccessToken | null,
): Promise<OrgConstitution[]> {
  // OAuth-bearer callers see only the orgs their token grants. Cookie
  // callers (oauthGrant null) see every org they belong to.
  if (oauthGrant && (oauthGrant.granted_org_ids ?? []).length === 0) {
    return [];
  }
  return withClient(async (c) => {
    const orgs = await c.query<{ id: string; handle: string | null; slug: string; name: string }>(
      oauthGrant
        ? `SELECT o.id, o.handle, o.slug, o.name
             FROM organizations o
             JOIN org_users m ON m.org_id = o.id
            WHERE m.collaborator_id = $1
              AND o.id = ANY($2::text[])
            ORDER BY o.slug`
        : `SELECT o.id, o.handle, o.slug, o.name
             FROM organizations o
             JOIN org_users m ON m.org_id = o.id
            WHERE m.collaborator_id = $1
            ORDER BY o.slug`,
      oauthGrant
        ? [principalId, oauthGrant.granted_org_ids ?? []]
        : [principalId],
    );
    const out: OrgConstitution[] = [];
    for (const o of orgs.rows) {
      const [guidance, nodeAuthoring] = await Promise.all([
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM org_guidance_primitives
            WHERE org_id = $1
              AND COALESCE(lifecycle, 'active') = 'active'
            ORDER BY created_at DESC`,
          [o.id],
        ),
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM org_neuron_authoring_primitives
            WHERE org_id = $1
              AND COALESCE(lifecycle, 'active') = 'active'
            ORDER BY created_at DESC`,
          [o.id],
        ),
      ]);
      out.push({
        org_id: o.id,
        org_handle: o.handle ?? o.slug,
        org_name: o.name,
        guidance_primitives: guidance.rows,
        neuron_authoring_primitives: nodeAuthoring.rows,
      });
    }
    return out;
  });
}

async function loadDocoConstitutionsForPrincipal(
  request: Request,
  principalId: string | null,
  oauthGrant: ValidAccessToken | null,
): Promise<DocoConstitution[]> {
  const all = await listAllDocos();
  const out: DocoConstitution[] = [];
  for (const d of all) {
    const meta = { ownerId: d.owner_id, visibility: d.visibility, docoId: d.id };
    // OAuth-bearer callers: token's per-Doco or per-org grant must
    // cover this Doco. Cookie callers fall through to the principal-
    // level check below.
    if (oauthGrant && !oauthTokenGrantsDoco(oauthGrant, meta)) continue;
    if (!(await canAccessDoco(meta, principalId))) continue;
    const [guidance, nodeAuthoring] = await withClient((c) =>
      Promise.all([
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM guidance_primitives
            WHERE doco_id = $1
              AND COALESCE(lifecycle, 'active') = 'active'
            ORDER BY created_at DESC`,
          [d.id],
        ),
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM neuron_authoring_primitives
            WHERE doco_id = $1
              AND COALESCE(lifecycle, 'active') = 'active'
            ORDER BY created_at DESC`,
          [d.id],
        ),
      ]),
    );
    if (guidance.rows.length === 0 && nodeAuthoring.rows.length === 0) continue;
    out.push({
      doco_id: d.id,
      doco_handle: d.handle,
      owner_id: d.owner_id,
      guidance_primitives: guidance.rows,
      neuron_authoring_primitives: nodeAuthoring.rows,
    });
  }
  return out;
}
