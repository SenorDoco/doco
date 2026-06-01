import {
  type DocoRole,
  getDocoById,
  getOrgRole,
  getUserById,
  listDocoIdsForUser,
  listDocoUsers,
  listOrganizationsForUser,
  withClient,
} from "@doco/db";
import { type EntityId, normalizeWriteTypes } from "@doco/shared";
import { redirect } from "react-router";
import { rootDir } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { qualifiedDocoLabel } from "~/lib/doco-labels";
import { InviteStore } from "~/lib/invite-store.server";
import { getCurrentPrincipal, userDisplayName } from "~/lib/session.server";
import {
  ALL_ROLES,
  type InviteGrantSpec,
  type InviteLevel,
  type UserInviteActionResult,
  type UserInviteData,
  parseInviteLevel,
  rankOf,
  resolveInviteDefaultSelection,
} from "~/lib/user-invite";

export type CurrentPrincipal = NonNullable<Awaited<ReturnType<typeof getCurrentPrincipal>>>;

export type PrincipalKind = "person";

export interface UserCell {
  user_id: string;
  username: string;
  kind: PrincipalKind;
  last_activity_at: string | null;
}

export interface GrantRow extends UserCell {
  role: DocoRole;
  write_types: string[];
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
  orgSections: OrgSection[];
  docoSections: DocoSection[];
  invite: UserInviteData;
}

async function enrichPrincipal(id: string, lastActivity: Map<string, string>): Promise<UserCell> {
  const c = await getUserById(id);
  return {
    user_id: id,
    username: c ? userDisplayName(c) : id,
    kind: "person",
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
    rows: Array<{ user_id: string; role: DocoRole; write_types: string[]; joined_at: string }>;
  }> = [];
  const allPrincipalIds = new Set<string>();
  for (const org of myOrgs) {
    const myRole = (await getOrgRole(org.id, principalId)) ?? "reader";
    const result = await withClient(async (c) =>
      c.query<{ user_id: string; role: string; write_types: string[]; joined_at: string | Date }>(
        "SELECT user_id, role, write_types, joined_at FROM org_users WHERE org_id = $1 ORDER BY joined_at",
        [org.id],
      ),
    );
    const rows = result.rows.map((row) => {
      allPrincipalIds.add(String(row.user_id));
      return {
        user_id: String(row.user_id),
        role: row.role as DocoRole,
        write_types: normalizeWriteTypes(row.write_types),
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
    rows: Array<{ user_id: string; role: DocoRole; write_types: string[]; joined_at: string }>;
  }> = [];
  for (const docoId of accessibleDocoIds) {
    const doco = await getDocoById(docoId);
    if (!doco) continue;
    const users = await listDocoUsers(docoId);
    const rows = users.map((u) => {
      allPrincipalIds.add(u.user_id);
      return {
        user_id: u.user_id,
        role: u.role,
        write_types: u.write_types,
        joined_at: u.joined_at,
      };
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
        ...(await enrichPrincipal(row.user_id, lastActivity)),
        role: row.role,
        write_types: row.write_types,
        joined_at: row.joined_at,
      })),
    );
    orgSections.push({ org: entry.org, myRole: entry.myRole, users });
  }

  const docoSections: DocoSection[] = [];
  for (const entry of docoRoleRows) {
    const users: GrantRow[] = await Promise.all(
      entry.rows.map(async (row) => ({
        ...(await enrichPrincipal(row.user_id, lastActivity)),
        role: row.role,
        write_types: row.write_types,
        joined_at: row.joined_at,
      })),
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

export async function loadUsersPageData(request: Request): Promise<UsersPageData> {
  const me = await requireCurrentPrincipal(request);
  const { orgSections, docoSections } = await loadUserSections(me.id);
  const invite = buildUserInviteData({ request, orgSections, docoSections });
  return { me, orgSections, docoSections, invite };
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
    // ownerId is the org id for org-owned docos; lets the grant picker
    // group docos under the org the user selects first.
    orgId: s.doco.ownerId,
  }));

  // Pre-select the invite target from the URL. The page (and the Doco's
  // "Collaborators" tab) links here with `?scope=<level>:<id>`.
  let requestedLevel: InviteLevel | null = null;
  let requestedTargetId = "";
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

  // Multi-grant invite (one link, all grants): the wizard posts a `grants`
  // JSON array. Validate each grant against the inviter's own role on that
  // target, then issue ONE invite carrying them all.
  const rawGrants = form.get("grants");
  if (typeof rawGrants === "string" && rawGrants.trim()) {
    return await handleMultiGrantInvite(request, me, rawGrants);
  }

  const level = String(form.get("level") ?? "") as InviteLevel;
  const parsedRole = String(form.get("role") ?? "") as DocoRole;
  if (parsedRole && !ALL_ROLES.includes(parsedRole)) return { error: "Invalid role." };
  const targetId = String(form.get("target_id") ?? "").trim();
  if (!targetId) return { error: "Pick a target to invite to." };
  // Optional per-type write set (decision_per_type_write_grants),
  // comma-separated type tokens or "*". Absent → upsert default on redeem.
  const rawWriteTypes = form.get("write_types");
  const writeTypes =
    rawWriteTypes === null
      ? undefined
      : normalizeWriteTypes(
          String(rawWriteTypes)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );

  // Account-level invite: grants the redeemer access to the inviter's
  // whole account. No target — the inviter IS the scope.
  // Anyone may invite into their own account; the grant is capped at
  // owner (the broadest delegation) and stored on the invite as an
  // account grant keyed to the inviter.
  if (level === "account") {
    const role: DocoRole = parsedRole || "writer";
    const store = InviteStore.forDoco(rootDir());
    const invite = await store.issueInvite(null, me.id as EntityId<"principal">, 3, role, {
      level: "account",
      account_grantor_user_id: me.id as EntityId<"principal">,
      ...(writeTypes ? { write_types: writeTypes } : {}),
    });
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    return {
      intent: "invite",
      ok: true,
      invite_url: `${origin}/invite/${invite.code}`,
      doco_url: "",
      recipe_url: `${origin}/protocol/agent-oauth-recipe`,
      device_url: `${origin}/device`,
      invite_expires_at: invite.expires_at,
      level,
      role,
    };
  }

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
      ...(writeTypes ? { write_types: writeTypes } : {}),
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

/** The inviter's own role on a grant target, for the role-cap check. */
async function inviterRoleOnTarget(
  meId: string,
  level: "account" | "org" | "doco",
  targetId: string,
): Promise<DocoRole | null> {
  if (level === "account") {
    // You can mint an account invite only if you own at least one org.
    const orgs = await listOrganizationsForUser(meId);
    for (const o of orgs) {
      if ((await getOrgRole(o.id, meId)) === "owner") return "owner";
    }
    return null;
  }
  if (level === "org") return getOrgRole(targetId, meId);
  const doco = await getDocoById(targetId);
  if (!doco) return null;
  return getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, meId);
}

/**
 * Multi-grant person invite (one link, all grants). Validates each grant's
 * role-cap against the inviter's own role, then issues ONE invite carrying a
 * grants[] array that redemption applies in full.
 */
async function handleMultiGrantInvite(
  request: Request,
  me: CurrentPrincipal,
  rawGrants: string,
): Promise<UserInviteActionResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawGrants);
  } catch {
    return { error: "Malformed grants." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "Pick at least one thing to grant access to." };
  }

  const specs: InviteGrantSpec[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") return { error: "Malformed grant entry." };
    const g = raw as { level?: unknown; targetId?: unknown; role?: unknown; writeTypes?: unknown };
    const level = g.level === "account" || g.level === "org" || g.level === "doco" ? g.level : null;
    const role = typeof g.role === "string" ? (g.role as DocoRole) : null;
    const targetId = typeof g.targetId === "string" ? g.targetId : "";
    if (!level || !role || !ALL_ROLES.includes(role)) return { error: "Invalid grant." };
    if (level !== "account" && !targetId) return { error: "Grant missing a target." };

    const myRole = await inviterRoleOnTarget(me.id, level, targetId);
    if (!myRole) return { error: `You don't have access to grant on a ${level}.` };
    if (rankOf(role) > rankOf(myRole)) {
      return { error: `Can't grant '${role}' where you only hold '${myRole}'.` };
    }
    const write_types = normalizeWriteTypes(Array.isArray(g.writeTypes) ? g.writeTypes : []);
    specs.push({
      level,
      target_id: targetId,
      role,
      write_types,
      ...(level === "account" ? { account_grantor_user_id: me.id } : {}),
    });
  }

  const store = InviteStore.forDoco(rootDir());
  const firstDoco = specs.find((s) => s.level === "doco");
  const invite = await store.issueInvite(
    firstDoco ? (firstDoco.target_id as EntityId<"doco">) : null,
    me.id as EntityId<"principal">,
    3,
    specs[0].role,
    { level: specs[0].level, grants: specs },
  );
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  return {
    intent: "invite",
    ok: true,
    invite_url: `${origin}/invite/${invite.code}`,
    doco_url: "",
    recipe_url: `${origin}/protocol/agent-oauth-recipe`,
    device_url: `${origin}/device`,
    invite_expires_at: invite.expires_at,
    level: specs[0].level,
    role: specs[0].role,
  };
}
