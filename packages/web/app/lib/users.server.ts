import {
  type DocoRole,
  type UserRow,
  getDocoById,
  getOrgRole,
  getUserById,
  listDocoIdsForUser,
  listDocoUsers,
  listOrganizationsForUser,
  patchUserData,
  withClient,
} from "@doco/db";
import type { EntityId } from "@doco/shared";
import { redirect } from "react-router";
import { rootDir } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { qualifiedDocoLabel } from "~/lib/doco-labels";
import { InviteStore } from "~/lib/invite-store.server";
import { getCurrentPrincipal, userDisplayName } from "~/lib/session.server";
import {
  ALL_ROLES,
  type InviteLevel,
  type UserInviteActionResult,
  type UserInviteData,
  parseInviteLevel,
  rankOf,
  resolveInviteDefaultSelection,
} from "~/lib/user-invite";

export type CurrentPrincipal = NonNullable<Awaited<ReturnType<typeof getCurrentPrincipal>>>;

export type PrincipalKind = "person" | "agent";

export interface UserCell {
  user_id: string;
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
  doco: { id: string; handle: string; ownerId: string; ownerSlug: string; label: string };
  myRole: DocoRole;
  users: GrantRow[];
}

export interface UsersPageData {
  me: CurrentPrincipal;
  host: string;
  orgSections: OrgSection[];
  docoSections: DocoSection[];
  invite: UserInviteData;
}

async function enrichPrincipal(id: string, lastActivity: Map<string, string>): Promise<UserCell> {
  // Post-rename: per-user metadata lives in the users
  // table; getUserById returns the kind/github_login + data directly.
  const c = await getUserById(id);
  const kind: PrincipalKind = c?.kind === "agent" ? "agent" : "person";
  return {
    user_id: id,
    // Display the human-facing name (agent's `data.name`, else GitHub
    // login), not the raw user id. Agents with no name yet fall back to
    // the id — an owner can rename them from this page.
    username: c ? userDisplayName(c) : id,
    kind,
    last_activity_at: lastActivity.get(id) ?? null,
  };
}

async function loadLastActivity(principalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (principalIds.length === 0) return out;
  const rows = await withClient((c) =>
    c.query<{ by_user: string; last_at: string | Date }>(
      `SELECT by_user, MAX(at) AS last_at
       FROM audit_events
       WHERE by_user = ANY($1)
       GROUP BY by_user`,
      [principalIds],
    ),
  );
  for (const row of rows.rows) {
    const at = row.last_at instanceof Date ? row.last_at.toISOString() : String(row.last_at);
    out.set(row.by_user, at);
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

export async function loadUserSections(principalId: string): Promise<{
  orgSections: OrgSection[];
  docoSections: DocoSection[];
}> {
  const myOrgs = await listOrganizationsForUser(principalId);
  const orgRoleRows: Array<{
    org: { id: string; handle: string; name: string };
    myRole: DocoRole;
    rows: Array<{ user_id: string; role: DocoRole; joined_at: string }>;
  }> = [];
  const allPrincipalIds = new Set<string>();
  for (const org of myOrgs) {
    const myRole = (await getOrgRole(org.id, principalId)) ?? "reader";
    const result = await withClient(async (c) =>
      c.query<{ user_id: string; role: string; joined_at: string | Date }>(
        "SELECT user_id, role, joined_at FROM org_users WHERE org_id = $1 ORDER BY joined_at",
        [org.id],
      ),
    );
    const rows = result.rows.map((row) => {
      allPrincipalIds.add(String(row.user_id));
      return {
        user_id: String(row.user_id),
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
         SELECT org_id FROM org_users WHERE user_id = $1
       )`,
      [principalId],
    ),
  );
  for (const r of orgDocos.rows) accessibleDocoIds.add(String(r.id));
  const myDocoUsersIds = await listDocoIdsForUser(principalId);
  for (const id of myDocoUsersIds) accessibleDocoIds.add(id);

  const docoRoleRows: Array<{
    doco: { id: string; handle: string; ownerId: string; ownerSlug: string; label: string };
    myRole: DocoRole;
    rows: Array<{ user_id: string; role: DocoRole; joined_at: string }>;
  }> = [];
  for (const docoId of accessibleDocoIds) {
    const doco = await getDocoById(docoId);
    if (!doco) continue;
    const users = await listDocoUsers(docoId);
    const rows = users.map((u) => {
      allPrincipalIds.add(u.user_id);
      return { user_id: u.user_id, role: u.role, joined_at: u.joined_at };
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

  // The Collaborators page lists only accounts with a username — i.e.
  // people. Agents are not collaborators: they authenticate through API
  // tokens and are managed on the API Tokens (/api-keys) page, so they
  // are filtered out of every section here.
  const personOnly = (users: GrantRow[]): GrantRow[] => users.filter((u) => u.kind !== "agent");

  const orgSections: OrgSection[] = [];
  for (const entry of orgRoleRows) {
    const users: GrantRow[] = personOnly(
      await Promise.all(
        entry.rows.map(async (row) => ({
          ...(await enrichPrincipal(row.user_id, lastActivity)),
          role: row.role,
          joined_at: row.joined_at,
        })),
      ),
    );
    orgSections.push({ org: entry.org, myRole: entry.myRole, users });
  }

  const docoSections: DocoSection[] = [];
  for (const entry of docoRoleRows) {
    const users: GrantRow[] = personOnly(
      await Promise.all(
        entry.rows.map(async (row) => ({
          ...(await enrichPrincipal(row.user_id, lastActivity)),
          role: row.role,
          joined_at: row.joined_at,
        })),
      ),
    );
    docoSections.push({
      doco: {
        id: entry.doco.id,
        handle: entry.doco.handle,
        ownerId: entry.doco.ownerId,
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

/**
 * Can `meId` rename agent collaborator `agent`? True when the viewer is
 * the person who authorized the agent, or an `owner` of an org the
 * agent's token is granted on ("the org the token belongs to"). Only
 * agents are renameable — people carry their GitHub login.
 */
export async function canRenameAgent(meId: string, agent: UserRow): Promise<boolean> {
  if (agent.kind !== "agent") return false;
  if (agent.owner_id === meId) return true;
  const owned = await withClient((c) =>
    c.query<{ org_id: string }>(
      `SELECT ou.org_id
         FROM org_users ou
         JOIN org_users meo
           ON meo.org_id = ou.org_id AND meo.user_id = $2 AND meo.role = 'owner'
        WHERE ou.user_id = $1
        LIMIT 1`,
      [agent.id, meId],
    ),
  );
  return owned.rows.length > 0;
}

export type RenameAgentResult =
  | { intent: "rename"; ok: true; user_id: string; username: string }
  | { error: string };

export async function renameAgentCollaborator(args: {
  meId: string;
  agentId: string;
  name: string;
}): Promise<RenameAgentResult> {
  const name = args.name.trim().replace(/\s+/g, " ");
  if (!name) return { error: "Name can't be empty." };
  if (name.length > 120) return { error: "Name must be 120 characters or less." };
  const agent = await getUserById(args.agentId);
  if (!agent || agent.kind !== "agent") {
    return { error: "Only agent collaborators can be renamed." };
  }
  if (!(await canRenameAgent(args.meId, agent))) {
    return { error: "Only an owner of the org this agent belongs to can rename it." };
  }
  const updated = await patchUserData(args.agentId, { name });
  return {
    intent: "rename",
    ok: true,
    user_id: args.agentId,
    username: updated ? userDisplayName(updated) : name,
  };
}

export async function loadUsersPageData(request: Request): Promise<UsersPageData> {
  const me = await requireCurrentPrincipal(request);
  const url = new URL(request.url);
  const { orgSections, docoSections } = await loadUserSections(me.id);
  const invite = buildUserInviteData({ request, orgSections, docoSections });
  return { me, host: `${url.protocol}//${url.host}`, orgSections, docoSections, invite };
}

function buildUserInviteData({
  request,
  orgSections,
  docoSections,
}: {
  request: Request;
  orgSections: OrgSection[];
  docoSections: DocoSection[];
}): UserInviteData {
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

  // Pre-select the invite target from the URL. The page (and the Doco's
  // "Collaborators" tab) links here with the modern `?scope=<level>:<id>`
  // param; older links used separate `?level=&target_id=`. Prefer scope,
  // fall back to the legacy pair.
  let requestedLevel = parseInviteLevel(url.searchParams.get("level"));
  let requestedTargetId = url.searchParams.get("target_id")?.trim() ?? "";
  const scope = url.searchParams.get("scope")?.trim() ?? "";
  if (scope && scope !== "all") {
    const sep = scope.indexOf(":");
    const scopedLevel = parseInviteLevel(sep === -1 ? scope : scope.slice(0, sep));
    const scopedTargetId = sep === -1 ? "" : scope.slice(sep + 1).trim();
    if (scopedLevel && scopedTargetId) {
      requestedLevel = scopedLevel;
      requestedTargetId = scopedTargetId;
    }
  }

  return {
    orgs: inviteOrgs,
    docos: inviteDocos,
    defaultSelection: resolveInviteDefaultSelection({
      requestedLevel,
      requestedTargetId,
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

export async function handleUserInviteAction(request: Request): Promise<UserInviteActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to invite users." };

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
    parsedRole || (rankOf(inviterRole) >= rankOf("writer") ? "writer" : inviterRole);
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
