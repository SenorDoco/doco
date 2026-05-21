// GET /api/v1/agent-bootstrap.json — agent-facing bootstrap manifest.
//
// Returns the Articles of the Constitution the caller has read-or-
// above access to, grouped by constitution:
//   - org_constitutions[]: every org the agent is a member of (any role)
//   - doco_constitutions[]: every Doco the agent can read (direct owner,
//     org-membership-inherited, doco_users grant, public visibility)
//
// Each constitution exposes two arrays of Articles of the
// Constitution: `guidance_articles` (prose, no automated check) and
// `node_authoring_articles` (rules evaluated at capture time). Org
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
// identity). Bearer/cookie callers receive everything they can read.

import { listAllDocos, withClient } from "@doco/db";
import { canAccessDoco } from "~/lib/doco-access.server";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

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
  guidance_articles: ArticleSummary[];
  node_authoring_articles: ArticleSummary[];
}

interface DocoConstitution {
  doco_id: string;
  doco_handle: string;
  owner_id: string;
  guidance_articles: ArticleSummary[];
  node_authoring_articles: ArticleSummary[];
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipalAsync(request);

  const orgConstitutions: OrgConstitution[] = me
    ? await loadOrgConstitutionsForPrincipal(me.id)
    : [];
  const docoConstitutions = await loadDocoConstitutionsForPrincipal(request, me?.id ?? null);

  return Response.json({
    principal: me ? { id: me.id, username: me.username } : null,
    canonical_instructions_url: new URL(
      "/protocol/canonical-instructions",
      new URL(request.url).origin,
    ).toString(),
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    org_constitutions: orgConstitutions,
    doco_constitutions: docoConstitutions,
  });
}

async function loadOrgConstitutionsForPrincipal(principalId: string): Promise<OrgConstitution[]> {
  return withClient(async (c) => {
    const orgs = await c.query<{ id: string; handle: string | null; slug: string; name: string }>(
      `SELECT o.id, o.handle, o.slug, o.name
         FROM organizations o
         JOIN org_users m ON m.org_id = o.id
        WHERE m.principal_id = $1
        ORDER BY o.slug`,
      [principalId],
    );
    const out: OrgConstitution[] = [];
    for (const o of orgs.rows) {
      const [guidance, nodeAuthoring] = await Promise.all([
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM org_guidance_articles
            WHERE org_id = $1
            ORDER BY created_at DESC`,
          [o.id],
        ),
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM org_node_authoring_articles
            WHERE org_id = $1
            ORDER BY created_at DESC`,
          [o.id],
        ),
      ]);
      out.push({
        org_id: o.id,
        org_handle: o.handle ?? o.slug,
        org_name: o.name,
        guidance_articles: guidance.rows,
        node_authoring_articles: nodeAuthoring.rows,
      });
    }
    return out;
  });
}

async function loadDocoConstitutionsForPrincipal(
  request: Request,
  principalId: string | null,
): Promise<DocoConstitution[]> {
  const all = await listAllDocos();
  const out: DocoConstitution[] = [];
  for (const d of all) {
    const meta = { ownerId: d.owner_id, visibility: d.visibility, docoId: d.id };
    if (!(await canAccessDoco(meta, principalId))) continue;
    const [guidance, nodeAuthoring] = await withClient((c) =>
      Promise.all([
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM guidance_articles
            WHERE doco_id = $1
            ORDER BY created_at DESC`,
          [d.id],
        ),
        c.query<{ id: string; summary: string; lifecycle: string | null; body_md: string | null }>(
          `SELECT id, summary, lifecycle, body_md
             FROM node_authoring_articles
            WHERE doco_id = $1
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
      guidance_articles: guidance.rows,
      node_authoring_articles: nodeAuthoring.rows,
    });
  }
  return out;
}
