import {
  type DocoRole,
  getCollaboratorById,
  getDocoById,
  getOrgRole,
  listDocoIdsForCollaborator,
  listDocoUsers,
  listOrganizationsForCollaborator,
  withClient,
} from "@doco/db";
import type { EntityId } from "@doco/shared";
import { redirect } from "react-router";
import {
  ALL_ROLES,
  type CollaboratorInviteActionResult,
  type CollaboratorInviteData,
  type InviteLevel,
  parseInviteLevel,
  rankOf,
  resolveInviteDefaultSelection,
} from "~/lib/collaborator-invite";
import { rootDir } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { InviteStore } from "~/lib/invite-store.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export type CurrentPrincipal = NonNullable<Awaited<ReturnType<typeof getCurrentPrincipal>>>;

export type PrincipalKind = "person" | "agent";

export interface UserCell {
  collaborator_id: string;
  username: string;
  kind: PrincipalKind;
  last_activity_at: string | null;
}

export type GrantSource = "principal" | "oauth";

export interface GrantRow extends UserCell {
  role: DocoRole;
  joined_at: string;
  source: GrantSource;
  client_id?: string;
}

export interface OrgSection {
  org: { id: string; slug: string; name: string };
  myRole: DocoRole;
  users: GrantRow[];
}

export interface DocoSection {
  doco: { id: string; handle: string };
  myRole: DocoRole;
  users: GrantRow[];
}

export interface CollaboratorsPageData {
  me: CurrentPrincipal;
  orgSections: OrgSection[];
  docoSections: DocoSection[];
}

export interface CollaboratorInvitePageData {
  me: CurrentPrincipal;
  host: string;
  invite: CollaboratorInviteData;
}

async function enrichPrincipal(
  id: string,
  lastActivity: Map<string, string>,
): Promise<UserCell> {
  // Post-rename: per-collaborator metadata lives in the collaborators
  // table; getCollaboratorById returns the kind/github_login directly.
  const c = await getCollaboratorById(id);
  const kind: PrincipalKind = c?.kind === "agent" ? "agent" : "person";
  return {
    collaborator_id: id,
    username: c?.github_login ?? id,
    kind,
    last_activity_at: lastActivity.get(id) ?? null,
  };
}

async function loadLastActivity(principalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (principalIds.length === 0) return out;
  const rows = await withClient((c) =>
    c.query<{ by_collaborator: string; last_at: string | Date }>(
      `SELECT by_collaborator, MAX(at) AS last_at
       FROM audit_events
       WHERE by_collaborator = ANY($1)
       GROUP BY by_collaborator`,
      [principalIds],
    ),
  );
  for (const row of rows.rows) {
    const at = row.last_at instanceof Date ? row.last_at.toISOString() : String(row.last_at);
    out.set(row.by_collaborator, at);
  }
  return out;
}

interface OauthGrantSlice {
  client_id: string;
  client_name: string;
  target_id: string;
  role: DocoRole;
  granted_at: string;
}

async function loadOauthAgentGrants(principalId: string): Promise<{
  orgs: OauthGrantSlice[];
  docos: OauthGrantSlice[];
}> {
  // One active grant per OAuth client × principal — pick the most recent
  // non-revoked, non-expired refresh token (refresh tokens are long-lived
  // and survive across access-token rotation, so they're the stable
  // signal that an agent still has access).
  const rows = await withClient((c) =>
    c.query<{
      client_id: string;
      client_name: string | null;
      granted_doco_ids: string[];
      granted_doco_roles: Record<string, string> | null;
      granted_org_ids: string[];
      granted_org_roles: Record<string, string> | null;
      created_at: Date | string;
    }>(
      `SELECT DISTINCT ON (rt.client_id)
              rt.client_id, c.client_name,
              rt.granted_doco_ids, rt.granted_doco_roles,
              rt.granted_org_ids, rt.granted_org_roles,
              rt.created_at
         FROM oauth_refresh_tokens rt
         JOIN oauth_clients c ON c.client_id = rt.client_id
        WHERE rt.revoked = false
          AND rt.expires_at > now()
          AND rt.collaborator_id = $1
        ORDER BY rt.client_id, rt.created_at DESC`,
      [principalId],
    ),
  );
  const orgs: OauthGrantSlice[] = [];
  const docos: OauthGrantSlice[] = [];
  for (const row of rows.rows) {
    const grantedAt =
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    const clientName = row.client_name ?? row.client_id;
    for (const orgId of row.granted_org_ids ?? []) {
      const role = (row.granted_org_roles?.[orgId] ?? "reader") as DocoRole;
      orgs.push({
        client_id: row.client_id,
        client_name: clientName,
        target_id: orgId,
        role,
        granted_at: grantedAt,
      });
    }
    for (const docoId of row.granted_doco_ids ?? []) {
      const role = (row.granted_doco_roles?.[docoId] ?? "reader") as DocoRole;
      docos.push({
        client_id: row.client_id,
        client_name: clientName,
        target_id: docoId,
        role,
        granted_at: grantedAt,
      });
    }
  }
  return { orgs, docos };
}

function oauthSliceToGrantRow(slice: OauthGrantSlice): GrantRow {
  return {
    collaborator_id: `oauth:${slice.client_id}`,
    username: slice.client_name,
    kind: "agent",
    last_activity_at: null,
    role: slice.role,
    joined_at: slice.granted_at,
    source: "oauth",
    client_id: slice.client_id,
  };
}

function requestPath(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

async function requireCurrentPrincipal(request: Request): Promise<CurrentPrincipal> {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent(requestPath(request))}`);
  return me;
}

export async function loadCollaboratorSections(principalId: string): Promise<{
  orgSections: OrgSection[];
  docoSections: DocoSection[];
}> {
  const myOrgs = await listOrganizationsForCollaborator(principalId);
  const orgRoleRows: Array<{
    org: { id: string; slug: string; name: string };
    myRole: DocoRole;
    rows: Array<{ collaborator_id: string; role: DocoRole; joined_at: string }>;
  }> = [];
  const allPrincipalIds = new Set<string>();
  for (const org of myOrgs) {
    const myRole = (await getOrgRole(org.id, principalId)) ?? "reader";
    const result = await withClient(async (c) =>
      c.query<{ collaborator_id: string; role: string; joined_at: string | Date }>(
        "SELECT collaborator_id, role, joined_at FROM org_users WHERE org_id = $1 ORDER BY joined_at",
        [org.id],
      ),
    );
    const rows = result.rows.map((row) => {
      allPrincipalIds.add(String(row.collaborator_id));
      return {
        collaborator_id: String(row.collaborator_id),
        role: row.role as DocoRole,
        joined_at:
          row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
      };
    });
    orgRoleRows.push({
      org: { id: org.id, slug: org.slug, name: org.name },
      myRole,
      rows,
    });
  }

  // Union of three sources: direct owner_id match, owning org membership,
  // and explicit doco_users rows.
  const accessibleDocoIds = new Set<string>();
  const directDocos = await withClient((c) =>
    c.query<{ id: string }>("SELECT id FROM docos WHERE owner_id = $1", [principalId]),
  );
  for (const r of directDocos.rows) accessibleDocoIds.add(String(r.id));
  const orgDocos = await withClient((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT org_id FROM org_users WHERE collaborator_id = $1
       )`,
      [principalId],
    ),
  );
  for (const r of orgDocos.rows) accessibleDocoIds.add(String(r.id));
  const myDocoUsersIds = await listDocoIdsForCollaborator(principalId);
  for (const id of myDocoUsersIds) accessibleDocoIds.add(id);

  const docoRoleRows: Array<{
    doco: { id: string; handle: string; ownerId: string };
    myRole: DocoRole;
    rows: Array<{ collaborator_id: string; role: DocoRole; joined_at: string }>;
  }> = [];
  for (const docoId of accessibleDocoIds) {
    const doco = await getDocoById(docoId);
    if (!doco) continue;
    const users = await listDocoUsers(docoId);
    const rows = users.map((u) => {
      allPrincipalIds.add(u.collaborator_id);
      return { collaborator_id: u.collaborator_id, role: u.role, joined_at: u.joined_at };
    });
    const myRole =
      (await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, principalId)) ??
      "reader";
    docoRoleRows.push({
      doco: { id: doco.id, handle: doco.handle, ownerId: doco.owner_id },
      myRole,
      rows,
    });
  }

  const lastActivity = await loadLastActivity([...allPrincipalIds]);
  const oauthGrants = await loadOauthAgentGrants(principalId);

  const oauthOrgByTarget = new Map<string, GrantRow[]>();
  for (const slice of oauthGrants.orgs) {
    const list = oauthOrgByTarget.get(slice.target_id) ?? [];
    list.push(oauthSliceToGrantRow(slice));
    oauthOrgByTarget.set(slice.target_id, list);
  }
  const oauthDocoByTarget = new Map<string, GrantRow[]>();
  for (const slice of oauthGrants.docos) {
    const list = oauthDocoByTarget.get(slice.target_id) ?? [];
    list.push(oauthSliceToGrantRow(slice));
    oauthDocoByTarget.set(slice.target_id, list);
  }

  const orgSections: OrgSection[] = [];
  for (const entry of orgRoleRows) {
    const users: GrantRow[] = await Promise.all(
      entry.rows.map(async (row) => ({
        ...(await enrichPrincipal(row.collaborator_id, lastActivity)),
        role: row.role,
        joined_at: row.joined_at,
        source: "principal" as const,
      })),
    );
    users.push(...(oauthOrgByTarget.get(entry.org.id) ?? []));
    orgSections.push({ org: entry.org, myRole: entry.myRole, users });
  }

  const docoSections: DocoSection[] = [];
  for (const entry of docoRoleRows) {
    const users: GrantRow[] = await Promise.all(
      entry.rows.map(async (row) => ({
        ...(await enrichPrincipal(row.collaborator_id, lastActivity)),
        role: row.role,
        joined_at: row.joined_at,
        source: "principal" as const,
      })),
    );
    users.push(...(oauthDocoByTarget.get(entry.doco.id) ?? []));
    docoSections.push({
      doco: { id: entry.doco.id, handle: entry.doco.handle },
      myRole: entry.myRole,
      users,
    });
  }
  docoSections.sort((a, b) => a.doco.handle.localeCompare(b.doco.handle));

  return { orgSections, docoSections };
}

export async function loadCollaboratorsPageData(request: Request): Promise<CollaboratorsPageData> {
  const me = await requireCurrentPrincipal(request);
  const { orgSections, docoSections } = await loadCollaboratorSections(me.id);
  return { me, orgSections, docoSections };
}

function buildCollaboratorInviteData({
  request,
  orgSections,
  docoSections,
}: {
  request: Request;
  orgSections: OrgSection[];
  docoSections: DocoSection[];
}): CollaboratorInviteData {
  const url = new URL(request.url);
  const inviteOrgs = orgSections
    .filter((s) => s.myRole === "owner")
    .map((s) => ({
      id: s.org.id,
      label: s.org.slug,
    }));
  const inviteDocos = docoSections
    .filter((s) => s.myRole === "owner")
    .map((s) => ({
      id: s.doco.id,
      label: s.doco.handle,
    }));

  return {
    orgs: inviteOrgs,
    docos: inviteDocos,
    defaultSelection: resolveInviteDefaultSelection({
      requestedLevel: parseInviteLevel(url.searchParams.get("level")),
      requestedTargetId: url.searchParams.get("target_id")?.trim() ?? "",
      orgs: inviteOrgs,
      docos: inviteDocos,
    }),
  };
}

export async function loadCollaboratorInvitePageData(
  request: Request,
): Promise<CollaboratorInvitePageData> {
  const me = await requireCurrentPrincipal(request);
  const url = new URL(request.url);
  const { orgSections, docoSections } = await loadCollaboratorSections(me.id);
  return {
    me,
    host: `${url.protocol}//${url.host}`,
    invite: buildCollaboratorInviteData({ request, orgSections, docoSections }),
  };
}

export async function handleCollaboratorInviteAction(
  request: Request,
): Promise<CollaboratorInviteActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to invite collaborators." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "invite") return { error: `Unknown intent: ${intent}` };

  const level = String(form.get("level") ?? "") as InviteLevel;
  const role = String(form.get("role") ?? "author") as DocoRole;
  if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
  const targetId = String(form.get("target_id") ?? "").trim();
  if (!targetId) return { error: "Pick a target to invite to." };

  let inviterRole: DocoRole | null = null;
  let docoId: string | null = null;
  let orgId: string | null = null;

  if (level === "org") {
    inviterRole = await getOrgRole(targetId, me.id);
    orgId = targetId;
    const docoRow = await withClient(async (c) =>
      c.query<{ id: string }>("SELECT id FROM docos WHERE owner_id=$1 LIMIT 1", [targetId]),
    );
    docoId = docoRow.rows[0]?.id ?? null;
  } else if (level === "doco") {
    const doco = await getDocoById(targetId);
    if (doco) {
      inviterRole = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
      docoId = doco.id;
    }
  } else {
    return { error: "Invalid level." };
  }

  if (!docoId) {
    return { error: "Could not resolve the doco backing this invite." };
  }
  if (!inviterRole) {
    return { error: "You don't have a role on this target." };
  }
  if (inviterRole !== "owner") {
    return {
      error: `Only owners can grant access -- you hold '${inviterRole}' on this ${level}.`,
    };
  }
  if (rankOf(role) > rankOf(inviterRole)) {
    return {
      error: `Cannot mint a '${role}' invite -- you only hold '${inviterRole}' on this target.`,
    };
  }

  const store = InviteStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    docoId as EntityId<"doco">,
    me.id as EntityId<"principal">,
    3,
    role,
    {
      level,
      ...(orgId ? { org_id: orgId as EntityId<"organization"> } : {}),
    },
  );
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const docoRow = await getDocoById(docoId);
  const handle = docoRow?.handle ?? "";
  return {
    intent: "invite",
    ok: true,
    invite_url: `${origin}/invite/${invite.code}`,
    doco_url: handle ? `${origin}/${handle}/` : "",
    recipe_url: `${origin}/protocol/agent-oauth-recipe`,
    device_url: `${origin}/device`,
    invite_expires_at: invite.expires_at,
    level,
    role,
  };
}
