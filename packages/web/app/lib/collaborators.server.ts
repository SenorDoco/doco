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
import { qualifiedDocoLabel } from "~/lib/doco-labels";
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

export interface GrantRow extends UserCell {
  role: DocoRole;
  joined_at: string;
}

export interface OrgSection {
  org: { id: string; handle: string; name: string };
  myRole: DocoRole;
  users: GrantRow[];
}

export interface DocoSection {
  doco: { id: string; handle: string; ownerSlug: string; label: string };
  myRole: DocoRole;
  users: GrantRow[];
}

export interface CollaboratorsPageData {
  me: CurrentPrincipal;
  host: string;
  orgSections: OrgSection[];
  docoSections: DocoSection[];
  invite: CollaboratorInviteData;
}

async function enrichPrincipal(id: string, lastActivity: Map<string, string>): Promise<UserCell> {
  // Post-rename: per-collaborator metadata lives in the collaborators
  // table; getCollaboratorById returns the kind/github_login directly.
  const c = await getCollaboratorById(id);
  const kind: PrincipalKind = c?.kind === "agent" ? "agent" : "person";
  return {
    collaborator_id: id,
    username: collaboratorDisplayName(c, id),
    kind,
    last_activity_at: lastActivity.get(id) ?? null,
  };
}

function collaboratorDisplayName(
  c: Awaited<ReturnType<typeof getCollaboratorById>>,
  fallback: string,
): string {
  if (!c) return fallback;
  const named = c.data.name ?? c.data.display_name;
  if (typeof named === "string" && named.trim()) return named.trim();
  return c.github_login ?? c.id;
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
    org: { id: string; handle: string; name: string };
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
      org: { id: org.id, handle: org.handle, name: org.name },
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
    doco: { id: string; handle: string; ownerId: string; ownerSlug: string; label: string };
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
    const label = qualifiedDocoLabel({ ownerSlug: doco.owner_slug, handle: doco.handle });
    docoRoleRows.push({
      doco: {
        id: doco.id,
        handle: doco.handle,
        ownerId: doco.owner_id,
        ownerSlug: doco.owner_slug,
        label,
      },
      myRole,
      rows,
    });
  }

  const lastActivity = await loadLastActivity([...allPrincipalIds]);

  const orgSections: OrgSection[] = [];
  for (const entry of orgRoleRows) {
    const users: GrantRow[] = await Promise.all(
      entry.rows.map(async (row) => ({
        ...(await enrichPrincipal(row.collaborator_id, lastActivity)),
        role: row.role,
        joined_at: row.joined_at,
      })),
    );
    orgSections.push({ org: entry.org, myRole: entry.myRole, users });
  }

  const docoSections: DocoSection[] = [];
  for (const entry of docoRoleRows) {
    const users: GrantRow[] = await Promise.all(
      entry.rows.map(async (row) => ({
        ...(await enrichPrincipal(row.collaborator_id, lastActivity)),
        role: row.role,
        joined_at: row.joined_at,
      })),
    );
    docoSections.push({
      doco: {
        id: entry.doco.id,
        handle: entry.doco.handle,
        ownerSlug: entry.doco.ownerSlug,
        label: entry.doco.label,
      },
      myRole: entry.myRole,
      users,
    });
  }
  docoSections.sort((a, b) => a.doco.label.localeCompare(b.doco.label));

  return { orgSections, docoSections };
}

export async function loadCollaboratorsPageData(request: Request): Promise<CollaboratorsPageData> {
  const me = await requireCurrentPrincipal(request);
  const url = new URL(request.url);
  const { orgSections, docoSections } = await loadCollaboratorSections(me.id);
  const invite = buildCollaboratorInviteData({ request, orgSections, docoSections });
  return { me, host: `${url.protocol}//${url.host}`, orgSections, docoSections, invite };
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
  const inviteOrgs = orgSections.map((s) => ({
    id: s.org.id,
    label: s.org.handle,
    maxRole: s.myRole,
  }));
  const inviteDocos = docoSections.map((s) => ({
    id: s.doco.id,
    label: s.doco.label,
    maxRole: s.myRole,
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

async function loadOrgInviteTarget(orgId: string): Promise<{
  orgId: string;
  orgHandle: string;
  anchorDocoId: string | null;
} | null> {
  const result = await withClient(async (c) =>
    c.query<{ id: string; handle: string; doco_id: string | null }>(
      `SELECT o.id, o.handle, d.id AS doco_id
         FROM organizations o
         LEFT JOIN LATERAL (
           SELECT id
             FROM docos
            WHERE org_id = o.id
            ORDER BY handle ASC
            LIMIT 1
         ) d ON true
        WHERE o.id = $1
        LIMIT 1`,
      [orgId],
    ),
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    orgId: String(row.id),
    orgHandle: String(row.handle),
    anchorDocoId: row.doco_id ? String(row.doco_id) : null,
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
  const parsedRole = String(form.get("role") ?? "") as DocoRole;
  if (parsedRole && !ALL_ROLES.includes(parsedRole)) return { error: "Invalid role." };
  const targetId = String(form.get("target_id") ?? "").trim();
  if (!targetId) return { error: "Pick a target to invite to." };

  let inviterRole: DocoRole | null = null;
  let docoId: string | null = null;
  let orgId: string | null = null;
  let orgHandle: string | null = null;

  if (level === "org") {
    inviterRole = await getOrgRole(targetId, me.id);
    const target = await loadOrgInviteTarget(targetId);
    if (!target) return { error: "Organization not found." };
    orgId = target.orgId;
    orgHandle = target.orgHandle;
    docoId = target.anchorDocoId;
  } else if (level === "doco") {
    const doco = await getDocoById(targetId);
    if (doco) {
      inviterRole = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
      docoId = doco.id;
    }
  } else {
    return { error: "Invalid level." };
  }

  if (level === "doco" && !docoId) {
    return { error: "Could not resolve the doco backing this invite." };
  }
  if (!inviterRole) {
    return { error: "You don't have a role on this target." };
  }
  const role: DocoRole =
    parsedRole || (rankOf(inviterRole) >= rankOf("author") ? "author" : inviterRole);
  if (rankOf(role) > rankOf(inviterRole)) {
    return {
      error: `Cannot mint a '${role}' invite -- you only hold '${inviterRole}' on this target.`,
    };
  }

  const store = InviteStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    docoId ? (docoId as EntityId<"doco">) : null,
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
  const docoRow = docoId ? await getDocoById(docoId) : null;
  const handle = docoRow?.handle ?? "";
  return {
    intent: "invite",
    ok: true,
    invite_url: `${origin}/invite/${invite.code}`,
    doco_url: handle ? `${origin}/${handle}/` : orgHandle ? `${origin}/orgs/${orgHandle}/` : "",
    recipe_url: `${origin}/protocol/agent-oauth-recipe`,
    device_url: `${origin}/device`,
    invite_expires_at: invite.expires_at,
    level,
    role,
  };
}
