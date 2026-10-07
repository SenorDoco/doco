// Shared agent-bootstrap manifest builder.
//
// The single source of truth for the policies + workspace constitutions an
// agent is handed. Every agent surface renders from THIS so they can never
// silently diverge:
//   - GET /api/v1/agent-bootstrap.json (external / OAuth / hook-token agents)
//   - the in-page Señor Doco sidebar (packages/web/app/lib/agent-chat.server.ts)
//
// Before this module existed, the sidebar had its own parallel context builder
// that never carried the constitution — that drift is the bug this exists to
// prevent. `loadWorkspaceConstitutionsForPrincipal` deliberately resolves to the
// EXACT same workspace set as `loadBootstrapForPrincipal`, by sharing the
// access filter and reachability helpers below.

import {
  type WorkspaceConstitution,
  getWorkspaceConstitutionsByIds,
  listAllDocos,
  listWorkspacesForUser,
  withClient,
} from "@doco/db";
import { type PolicyPredicate, agentInstructionOf } from "@doco/shared";
import {
  canAccessDoco,
  listReadableDocosInWorkspace,
  oauthTokenGrantsDoco,
} from "./doco-access.server";
import type { HookToken } from "./hook-tokens.server";
import type { ValidAccessToken } from "./oauth-server.server";

export type { WorkspaceConstitution };

export interface PolicyArticle {
  id: string;
  /** suggestion | deterministic | probabilistic. */
  kind: string;
  /** suggestion / probabilistic: the natural-language instruction (else null). */
  agent_instruction: string | null;
  /** deterministic: the structured check (else the agent-instruction predicate). */
  predicate: PolicyPredicate | null;
  lifecycle: string | null;
}

export interface DocoPolicySet {
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
  policies: PolicyArticle[];
}

export interface BootstrapManifest {
  docoPolicies: DocoPolicySet[];
  workspaceConstitutions: WorkspaceConstitution[];
}

export async function loadPolicyArticles(docoId: string): Promise<PolicyArticle[]> {
  return withClient((c) => queryPolicyArticles(c, docoId));
}

/** The active policies of one Doco as articles, read on the given client. */
export async function queryPolicyArticles(
  c: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
  docoId: string,
): Promise<PolicyArticle[]> {
  const rows = await c.query<{
    id: string;
    kind: string | null;
    data: Record<string, unknown> | null;
    lifecycle: string | null;
  }>(
    `SELECT id, kind, data, lifecycle
       FROM policies
      WHERE doco_id = $1
        AND COALESCE(lifecycle, 'active') = 'active'
      ORDER BY created_at DESC`,
    [docoId],
  );
  return rows.rows.map((row) => {
    const predicate = (row.data?.predicate ?? null) as PolicyPredicate | null;
    return {
      id: row.id,
      kind: row.kind ?? (typeof row.data?.kind === "string" ? row.data.kind : "suggestion"),
      agent_instruction: predicate ? agentInstructionOf(predicate) : null,
      predicate,
      lifecycle: row.lifecycle,
    };
  });
}

/**
 * Docos the caller may read. The single access filter shared by the policy
 * manifest and the constitution scope, so the two never disagree on which
 * workspaces are reachable. OAuth-bearer callers are additionally gated by the
 * token's per-Doco / per-workspace grant; cookie callers fall through to the
 * principal-level check.
 */
async function listAccessibleDocos(
  principalId: string | null,
  oauthGrant: ValidAccessToken | null,
): Promise<Awaited<ReturnType<typeof listAllDocos>>> {
  const all = await listAllDocos();
  const out: Awaited<ReturnType<typeof listAllDocos>> = [];
  for (const d of all) {
    const meta = { ownerId: d.owner_id, visibility: d.visibility, docoId: d.id };
    if (oauthGrant && !oauthTokenGrantsDoco(oauthGrant, meta)) continue;
    if (!(await canAccessDoco(meta, principalId))) continue;
    out.push(d);
  }
  return out;
}

/**
 * Every workspace the caller can reach: those owning an accessible Doco, plus
 * workspaces granted directly (OAuth) or by membership (cookie) — so a granted
 * or joined workspace with no Docos yet still contributes its constitution.
 */
async function reachableWorkspaceIds(
  accessibleDocos: { workspace_id: string }[],
  principalId: string | null,
  oauthGrant: ValidAccessToken | null,
): Promise<string[]> {
  const ids = new Set<string>(accessibleDocos.map((d) => d.workspace_id));
  if (oauthGrant) {
    for (const id of oauthGrant.granted_workspace_ids) ids.add(id);
  } else if (principalId) {
    for (const workspace of await listWorkspacesForUser(principalId)) ids.add(workspace.id);
  }
  return [...ids];
}

export async function loadBootstrapForPrincipal(
  principalId: string | null,
  oauthGrant: ValidAccessToken | null,
): Promise<BootstrapManifest> {
  const accessible = await listAccessibleDocos(principalId, oauthGrant);
  const docoPolicies: DocoPolicySet[] = [];
  for (const d of accessible) {
    const policies = await loadPolicyArticles(d.id);
    // A Doco shows up in bootstrap when it has at least one policy
    // OR a non-empty goal — the goal is itself bootstrap context, not
    // just decoration on top of policies.
    if (policies.length === 0 && d.goal.length === 0) continue;
    docoPolicies.push({
      doco_id: d.id,
      doco_handle: d.handle,
      goal: d.goal,
      owner_id: d.owner_id,
      policies,
    });
  }
  const workspaceConstitutions = await getWorkspaceConstitutionsByIds(
    await reachableWorkspaceIds(accessible, principalId, oauthGrant),
  );
  return { docoPolicies, workspaceConstitutions };
}

/**
 * The constitution slice of the bootstrap manifest, on its own. Señor Doco
 * renders this without paying for the per-Doco policy fan-out it already
 * gathers separately — but it resolves to the EXACT same workspace set as
 * {@link loadBootstrapForPrincipal}, so the sidebar and the external manifest
 * never disagree on which constitutions apply.
 */
export async function loadWorkspaceConstitutionsForPrincipal(
  principalId: string | null,
  oauthGrant: ValidAccessToken | null = null,
): Promise<WorkspaceConstitution[]> {
  const accessible = await listAccessibleDocos(principalId, oauthGrant);
  return getWorkspaceConstitutionsByIds(
    await reachableWorkspaceIds(accessible, principalId, oauthGrant),
  );
}

/** A hook token reads one workspace as the person who made it: its
 *  constitution, and the goal and policies of each Doco they can read there
 *  that has either. */
export async function loadBootstrapForHookToken(token: HookToken): Promise<BootstrapManifest> {
  const workspaceConstitutions = await getWorkspaceConstitutionsByIds([token.workspace_id]);
  const readable = await listReadableDocosInWorkspace(token.workspace_id, token.created_by_user_id);
  const docoPolicies: DocoPolicySet[] = [];
  await withClient(async (c) => {
    const docos = await c.query<{ id: string; handle: string; goal: string; owner_id: string }>(
      "SELECT id, handle, goal, owner_id FROM docos WHERE id = ANY($1::text[]) ORDER BY handle",
      [readable.map((d) => d.id)],
    );
    for (const d of docos.rows) {
      const policies = await queryPolicyArticles(c, d.id);
      if (policies.length === 0 && d.goal.length === 0) continue;
      docoPolicies.push({
        doco_id: d.id,
        doco_handle: d.handle,
        goal: d.goal,
        owner_id: d.owner_id,
        policies,
      });
    }
  });
  return { docoPolicies, workspaceConstitutions };
}
