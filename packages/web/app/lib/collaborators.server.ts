import {
  type DocoRole,
  getDocoById,
  getOrgRole,
  getPrincipalById,
  listDocoIdsForUserPrincipal,
  listDocoUsers,
  listOrganizationsForPrincipal,
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
import { getCurrentPrincipal } from "~/lib/session";

export type CurrentPrincipal = NonNullable<Awaited<ReturnType<typeof getCurrentPrincipal>>>;

export interface UserCell {
  principal_id: string;
  username: string;
}

export interface OrgSection {
  org: { id: string; slug: string; name: string };
  myRole: DocoRole;
  users: (UserCell & { role: DocoRole })[];
}

export interface DocoSection {
  doco: { id: string; handle: string };
  myRole: DocoRole;
  users: (UserCell & { role: DocoRole })[];
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

async function enrichPrincipal(id: string): Promise<UserCell> {
  const p = await getPrincipalById(id);
  return {
    principal_id: id,
    username: p?.username ?? id,
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
  const myOrgs = await listOrganizationsForPrincipal(principalId);
  const orgSections: OrgSection[] = [];
  for (const org of myOrgs) {
    const myRole = (await getOrgRole(org.id, principalId)) ?? "reader";
    const rows = await withClient(async (c) =>
      c.query<{ principal_id: string; role: string }>(
        "SELECT principal_id, role FROM org_users WHERE org_id = $1 ORDER BY joined_at",
        [org.id],
      ),
    );
    const users: OrgSection["users"] = await Promise.all(
      rows.rows.map(async (row) => ({
        ...(await enrichPrincipal(row.principal_id)),
        role: row.role as DocoRole,
      })),
    );
    orgSections.push({
      org: { id: org.id, slug: org.slug, name: org.name },
      myRole,
      users,
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
         SELECT org_id FROM org_users WHERE principal_id = $1
       )`,
      [principalId],
    ),
  );
  for (const r of orgDocos.rows) accessibleDocoIds.add(String(r.id));
  const myDocoUsersIds = await listDocoIdsForUserPrincipal(principalId);
  for (const id of myDocoUsersIds) accessibleDocoIds.add(id);

  const docoSections: DocoSection[] = [];
  for (const docoId of accessibleDocoIds) {
    const doco = await getDocoById(docoId);
    if (!doco) continue;
    const users = await listDocoUsers(docoId);
    const enriched = await Promise.all(
      users.map(async (u) => ({
        ...(await enrichPrincipal(u.principal_id)),
        role: u.role,
      })),
    );
    const myRole =
      (await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, principalId)) ??
      "reader";
    docoSections.push({
      doco: { id: doco.id, handle: doco.handle },
      myRole,
      users: enriched,
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
