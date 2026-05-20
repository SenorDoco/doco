// /users — global user-management page (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
// Replaces the per-doco / per-scope / per-org members pages. Top-level
// link in the host nav. Shows every org/doco/scope grant the signed-in
// principal can see, lets owners edit roles inline (auto-save), and
// mints invite links at any of the three levels.

import {
  type DocoRole,
  type ScopeUserRow,
  getDocoById,
  getOrgRole,
  getPrincipalById,
  listDocoIdsForUserPrincipal,
  listDocoUsers,
  listOrganizationsForPrincipal,
  listScopeIdsForUserPrincipal,
  listScopeUsers,
  removeDocoUser,
  removeOrgUser,
  removeScopeUser,
  upsertDocoUser,
  upsertOrgUser,
  upsertScopeUser,
  withClient,
} from "@doco/db";
import type { EntityId } from "@doco/shared";
import { useEffect, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { getCurrentPrincipal } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";

const ALL_ROLES: DocoRole[] = ["owner", "approver", "author", "reader"];
type InviteLevel = "org" | "doco" | "scope";
type InviteOption = { id: string; label: string };
type InviteDefaultSelection = { level: InviteLevel; targetId: string };

function rankOf(role: DocoRole): number {
  return role === "owner" ? 3 : role === "approver" ? 2 : role === "author" ? 1 : 0;
}

function parseInviteLevel(value: string | null): InviteLevel | null {
  return value === "org" || value === "doco" || value === "scope" ? value : null;
}

function optionsForInviteLevel(
  level: InviteLevel,
  options: {
    orgs: InviteOption[];
    docos: InviteOption[];
    scopes: InviteOption[];
  },
): InviteOption[] {
  if (level === "org") return options.orgs;
  if (level === "scope") return options.scopes;
  return options.docos;
}

function firstAvailableInviteLevel(options: {
  orgs: InviteOption[];
  docos: InviteOption[];
  scopes: InviteOption[];
}): InviteLevel {
  if (options.docos.length > 0) return "doco";
  if (options.orgs.length > 0) return "org";
  return "scope";
}

function resolveInviteDefaultSelection(args: {
  requestedLevel: InviteLevel | null;
  requestedTargetId: string;
  orgs: InviteOption[];
  docos: InviteOption[];
  scopes: InviteOption[];
}): InviteDefaultSelection {
  const level =
    args.requestedLevel ??
    firstAvailableInviteLevel({ orgs: args.orgs, docos: args.docos, scopes: args.scopes });
  const options = optionsForInviteLevel(level, args);
  const targetId = options.some((opt) => opt.id === args.requestedTargetId)
    ? args.requestedTargetId
    : (options[0]?.id ?? "");
  return { level, targetId };
}

interface UserCell {
  principal_id: string;
  username: string;
}

interface OrgSection {
  org: { id: string; slug: string; name: string };
  myRole: DocoRole;
  users: (UserCell & { role: DocoRole })[];
}

interface DocoSection {
  doco: { id: string; handle: string };
  myRole: DocoRole;
  users: (UserCell & { role: DocoRole })[];
}

interface ScopeSection {
  scope: { id: string; name: string };
  doco: { id: string; handle: string };
  myDocoRole: DocoRole | null;
  users: (UserCell & { role: DocoRole })[];
}

async function enrichPrincipal(id: string): Promise<UserCell> {
  const p = await getPrincipalById(id);
  return {
    principal_id: id,
    username: p?.username ?? id,
  };
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return redirect(`/sign-in?next=${encodeURIComponent("/users")}`);
  }
  const url = new URL(request.url);

  // ── Orgs the signed-in user belongs to ─────────────────────────────
  const myOrgs = await listOrganizationsForPrincipal(me.id);
  const orgSections: OrgSection[] = [];
  for (const org of myOrgs) {
    const myRole = (await getOrgRole(org.id, me.id)) ?? "reader";
    const rows = await withClient(async (c) =>
      c.query<{ principal_id: string; role: string }>(
        `SELECT principal_id, role FROM org_users WHERE org_id = $1 ORDER BY joined_at`,
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

  // ── Docos the signed-in user has any access to ───────────────────
  // Union of three sources: direct owner_id match, owning org I belong
  // to, and explicit doco_users row. The /users invite picker needs the
  // direct-owner path so freshly-created docos show up before any
  // doco_users row exists.
  const accessibleDocoIds = new Set<string>();
  const directDocos = await withClient((c) =>
    c.query<{ id: string }>(`SELECT id FROM docos WHERE owner_id = $1`, [me.id]),
  );
  directDocos.rows.forEach((r) => accessibleDocoIds.add(String(r.id)));
  const orgDocos = await withClient((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT org_id FROM org_users WHERE principal_id = $1
       )`,
      [me.id],
    ),
  );
  orgDocos.rows.forEach((r) => accessibleDocoIds.add(String(r.id)));
  const myDocoUsersIds = await listDocoIdsForUserPrincipal(me.id);
  myDocoUsersIds.forEach((id) => accessibleDocoIds.add(id));

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
    // Effective doco-level role (covers direct owner, org chain, doco_users).
    const myRole =
      (await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id)) ??
      "reader";
    docoSections.push({
      doco: { id: doco.id, handle: doco.handle },
      myRole,
      users: enriched,
    });
  }
  docoSections.sort((a, b) => a.doco.handle.localeCompare(b.doco.handle));

  // ── Scopes the signed-in user has a scope_users grant on ──────────
  const myScopeIds = await listScopeIdsForUserPrincipal(me.id);
  const scopeSections: ScopeSection[] = [];
  for (const scopeId of myScopeIds) {
    const scopeRow = await withClient(async (c) =>
      c.query<{ id: string; name: string; doco_id: string }>(
        `SELECT id, name, doco_id FROM scopes WHERE id = $1 LIMIT 1`,
        [scopeId],
      ),
    );
    const sc = scopeRow.rows[0];
    if (!sc) continue;
    const doco = await getDocoById(sc.doco_id);
    if (!doco) continue;
    const users: ScopeUserRow[] = await listScopeUsers(scopeId);
    const enriched = await Promise.all(
      users.map(async (u) => ({
        ...(await enrichPrincipal(u.principal_id)),
        role: u.role,
      })),
    );
    // My doco role (for the parent doco) determines if I can edit this
    // scope's users — only doco-owners can manage scope grants.
    const myDocoRow = await withClient(async (c) =>
      c.query<{ role: string }>(
        `SELECT role FROM doco_users WHERE doco_id = $1 AND principal_id = $2`,
        [doco.id, me.id],
      ),
    );
    const myDocoRole = (myDocoRow.rows[0]?.role as DocoRole | undefined) ?? null;
    scopeSections.push({
      scope: { id: sc.id, name: sc.name },
      doco: { id: doco.id, handle: doco.handle },
      myDocoRole,
      users: enriched,
    });
  }

  // ── Invite-target options: where can THIS user mint invites? ──────
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
  // Scope invites need doco-owner role on the containing doco. Surface
  // every scope inside any doco the user owns at the doco level.
  const ownerDocoIds = new Set(inviteDocos.map((d) => d.id));
  const inviteScopes = await (async () => {
    if (ownerDocoIds.size === 0) return [] as { id: string; label: string; doco_handle: string }[];
    return withClient(async (c) => {
      const r = await c.query<{ id: string; name: string; doco_id: string; handle: string }>(
        `SELECT s.id, s.name, s.doco_id, d.handle
         FROM scopes s JOIN docos d ON d.id = s.doco_id
         WHERE s.doco_id = ANY($1::text[]) ORDER BY d.handle, s.name`,
        [Array.from(ownerDocoIds)],
      );
      return r.rows.map((row) => ({
        id: String(row.id),
        label: `${row.handle} · ${row.name}`,
        doco_handle: String(row.handle),
      }));
    });
  })();

  return {
    me,
    orgSections,
    docoSections,
    scopeSections,
    invite: {
      orgs: inviteOrgs,
      docos: inviteDocos,
      scopes: inviteScopes,
      defaultSelection: resolveInviteDefaultSelection({
        requestedLevel: parseInviteLevel(url.searchParams.get("level")),
        requestedTargetId: url.searchParams.get("target_id")?.trim() ?? "",
        orgs: inviteOrgs,
        docos: inviteDocos,
        scopes: inviteScopes,
      }),
    },
  };
}

type ActionResult =
  | {
      intent: "invite";
      ok: true;
      invite_url: string;
      doco_url: string;
      recipe_url: string;
      device_url: string;
      invite_expires_at: string;
      level: "org" | "doco" | "scope";
      role: DocoRole;
    }
  | {
      intent: "update";
      ok: true;
      level: "org" | "doco" | "scope";
      target_id: string;
      principal_id: string;
      role: DocoRole;
    }
  | {
      intent: "remove";
      ok: true;
      level: "org" | "doco" | "scope";
      target_id: string;
      principal_id: string;
    }
  | { error: string };

export async function action({
  request,
}: {
  request: Request;
}): Promise<ActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to manage users." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const level = String(form.get("level") ?? "") as "org" | "doco" | "scope";

  if (intent === "update" || intent === "remove") {
    const targetId = String(form.get("target_id") ?? "").trim();
    const principalId = String(form.get("principal_id") ?? "").trim();
    if (!targetId) return { error: "target_id missing." };
    if (!principalId) return { error: "principal_id missing." };

    // Authorize: actor must be owner at that level. Use getDocoLevelRole
    // for the doco/scope path so direct-owner docos (no doco_users row)
    // pass the check.
    if (level === "org") {
      const role = await getOrgRole(targetId, me.id);
      if (role !== "owner") return { error: "Only org owners can change org users." };
    } else if (level === "doco") {
      const doco = await getDocoById(targetId);
      if (!doco) return { error: "Doco not found." };
      const role = await getDocoLevelRole(
        { ownerId: doco.owner_id, docoId: doco.id },
        me.id,
      );
      if (role !== "owner") return { error: "Only doco owners can change doco users." };
    } else if (level === "scope") {
      const sc = await withClient(async (c) =>
        c.query<{ doco_id: string }>(`SELECT doco_id FROM scopes WHERE id=$1`, [targetId]),
      );
      const docoId = sc.rows[0]?.doco_id;
      if (!docoId) return { error: "Scope not found." };
      const doco = await getDocoById(docoId);
      if (!doco) return { error: "Parent doco not found." };
      const role = await getDocoLevelRole(
        { ownerId: doco.owner_id, docoId: doco.id },
        me.id,
      );
      if (role !== "owner") return { error: "Only doco owners can change scope users." };
    } else {
      return { error: "Invalid level." };
    }

    if (intent === "update") {
      const role = String(form.get("role") ?? "") as DocoRole;
      if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
      if (level === "org")
        await upsertOrgUser({ org_id: targetId, principal_id: principalId, role });
      else if (level === "doco")
        await upsertDocoUser({ doco_id: targetId, principal_id: principalId, role });
      else await upsertScopeUser({ scope_id: targetId, principal_id: principalId, role });
      return {
        intent: "update",
        ok: true,
        level,
        target_id: targetId,
        principal_id: principalId,
        role,
      };
    }
    if (level === "org") await removeOrgUser(targetId, principalId);
    else if (level === "doco") await removeDocoUser(targetId, principalId);
    else await removeScopeUser(targetId, principalId);
    return { intent: "remove", ok: true, level, target_id: targetId, principal_id: principalId };
  }

  if (intent === "invite") {
    const role = String(form.get("role") ?? "author") as DocoRole;
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    const targetId = String(form.get("target_id") ?? "").trim();
    if (!targetId) return { error: "Pick a target to invite to." };

    let inviterRole: DocoRole | null = null;
    let docoId: string | null = null;
    let orgId: string | null = null;
    let scopeId: string | null = null;

    if (level === "org") {
      inviterRole = await getOrgRole(targetId, me.id);
      orgId = targetId;
      // We still need a doco_id on the invite for back-links; pick any
      // doco the org owns, falling back to the first one we find.
      const docoRow = await withClient(async (c) =>
        c.query<{ id: string }>(`SELECT id FROM docos WHERE owner_id=$1 LIMIT 1`, [targetId]),
      );
      docoId = docoRow.rows[0]?.id ?? null;
    } else if (level === "doco") {
      const doco = await getDocoById(targetId);
      if (doco) {
        inviterRole = await getDocoLevelRole(
          { ownerId: doco.owner_id, docoId: doco.id },
          me.id,
        );
        docoId = doco.id;
      }
    } else if (level === "scope") {
      const sc = await withClient(async (c) =>
        c.query<{ doco_id: string }>(`SELECT doco_id FROM scopes WHERE id=$1`, [targetId]),
      );
      docoId = sc.rows[0]?.doco_id ?? null;
      scopeId = targetId;
      if (docoId) {
        const doco = await getDocoById(docoId);
        if (doco) {
          inviterRole = await getDocoLevelRole(
            { ownerId: doco.owner_id, docoId: doco.id },
            me.id,
          );
        }
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
    if (rankOf(role) > rankOf(inviterRole)) {
      return {
        error: `Cannot mint a '${role}' invite — you only hold '${inviterRole}' on this target.`,
      };
    }

    const store = TokenStore.forDoco(rootDir());
    const invite = await store.issueInvite(
      docoId as EntityId<"doco">,
      me.id as EntityId<"principal">,
      3, // 72-hour TTL
      role,
      {
        level,
        ...(orgId ? { org_id: orgId as EntityId<"organization"> } : {}),
        ...(scopeId ? { scope_id: scopeId as EntityId<"scope"> } : {}),
      },
    );
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    // Resolve the Doco's handle so the agent prompt can name the per-
    // Doco URL alongside the OAuth recipe + Device-Flow approval page.
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

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Users · Doco" }];
}

interface UsersLoaderData {
  me: {
    id: string;
    username: string;
    type: "person" | "agent";
    isHuman: boolean;
    email?: string;
  };
  orgSections: OrgSection[];
  docoSections: DocoSection[];
  scopeSections: ScopeSection[];
  invite: {
    orgs: { id: string; label: string }[];
    docos: { id: string; label: string }[];
    scopes: { id: string; label: string; doco_handle: string }[];
    defaultSelection: InviteDefaultSelection;
  };
}

export default function UsersPage({
  loaderData,
}: {
  loaderData: UsersLoaderData;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Users (humans/agents)</h1>
        </header>

        <InviteCard
          orgs={loaderData.invite.orgs}
          docos={loaderData.invite.docos}
          scopes={loaderData.invite.scopes}
          defaultSelection={loaderData.invite.defaultSelection}
        />

        <Section
          title="Org users"
          empty="You don't have any org grants yet."
          rows={loaderData.orgSections.flatMap((s) =>
            s.users.map((u) => ({
              level: "org" as const,
              target_id: s.org.id,
              target_label: s.org.slug,
              target_link: `/orgs/${s.org.slug}`,
              user: u,
              canEdit: s.myRole === "owner",
            })),
          )}
        />

        <Section
          title="Doco users"
          empty="You don't have any doco grants yet."
          rows={loaderData.docoSections.flatMap((s) =>
            s.users.map((u) => ({
              level: "doco" as const,
              target_id: s.doco.id,
              target_label: s.doco.handle,
              target_link: `/${s.doco.handle}`,
              user: u,
              canEdit: s.myRole === "owner",
            })),
          )}
        />

        <Section
          title="Scope users"
          empty="You don't have any scope grants yet."
          rows={loaderData.scopeSections.flatMap((s) =>
            s.users.map((u) => ({
              level: "scope" as const,
              target_id: s.scope.id,
              target_label: `${s.doco.handle} · ${s.scope.name}`,
              target_link: `/${s.doco.handle}/scopes/${s.scope.id}`,
              user: u,
              canEdit: s.myDocoRole === "owner",
            })),
          )}
        />

      </SingleColumnPageMain>
    </div>
  );
}

interface SectionRow {
  level: "org" | "doco" | "scope";
  target_id: string;
  target_label: string;
  target_link: string;
  user: UserCell & { role: DocoRole };
  canEdit: boolean;
}

function Section({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: SectionRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 font-medium">User</th>
                <th className="pb-2 font-medium">Target</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <UserRow key={`${r.level}-${r.target_id}-${r.user.principal_id}-${i}`} row={r} />
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function UserRow({ row }: { row: SectionRow }) {
  const roleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();

  const justSaved =
    roleFetcher.state === "idle" &&
    roleFetcher.data &&
    "intent" in roleFetcher.data &&
    roleFetcher.data.intent === "update" &&
    roleFetcher.data.target_id === row.target_id &&
    roleFetcher.data.principal_id === row.user.principal_id;
  const error =
    roleFetcher.data && "error" in roleFetcher.data ? roleFetcher.data.error : undefined;

  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (justSaved) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [justSaved]);

  return (
    <tr data-testid={`row-${row.level}-${row.user.username}`}>
      <td className="py-2 align-middle">
        <div className="font-medium">{row.user.username}</div>
      </td>
      <td className="py-2 align-middle">
        <Link to={row.target_link} className="text-xs underline">
          {row.target_label}
        </Link>
      </td>
      <td className="py-2 align-middle">
        <div className="inline-flex items-center gap-2">
          <select
            defaultValue={row.user.role}
            disabled={!row.canEdit || roleFetcher.state !== "idle"}
            data-testid={`role-${row.level}-${row.user.username}`}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"
            onChange={(e) => {
              roleFetcher.submit(
                {
                  intent: "update",
                  level: row.level,
                  target_id: row.target_id,
                  principal_id: row.user.principal_id,
                  role: e.currentTarget.value,
                },
                { method: "post" },
              );
            }}
          >
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span
            className="text-xs text-muted-foreground"
            data-testid={`status-${row.level}-${row.user.username}`}
            aria-live="polite"
          >
            {roleFetcher.state !== "idle" ? (
              "Saving…"
            ) : error ? (
              <span className="text-destructive">{error}</span>
            ) : showSaved ? (
              "Saved"
            ) : (
              ""
            )}
          </span>
        </div>
      </td>
      <td className="py-2 align-middle text-right">
        {row.canEdit ? (
          <button
            type="button"
            disabled={removeFetcher.state !== "idle"}
            data-testid={`remove-${row.level}-${row.user.username}`}
            onClick={() => {
              if (!confirm(`Remove ${row.user.username} from ${row.target_label}?`)) return;
              removeFetcher.submit(
                {
                  intent: "remove",
                  level: row.level,
                  target_id: row.target_id,
                  principal_id: row.user.principal_id,
                },
                { method: "post" },
              );
            }}
            className="rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-card disabled:opacity-50"
          >
            {removeFetcher.state !== "idle" ? "Removing…" : "Remove"}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function InviteCard({
  orgs,
  docos,
  scopes,
  defaultSelection,
}: {
  orgs: { id: string; label: string }[];
  docos: { id: string; label: string }[];
  scopes: { id: string; label: string; doco_handle: string }[];
  defaultSelection: InviteDefaultSelection;
}) {
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data;
  const inviteResult = result && "intent" in result && result.intent === "invite" ? result : null;
  const error = result && "error" in result ? result.error : undefined;
  const [level, setLevel] = useState<InviteLevel>(defaultSelection.level);
  const [targetId, setTargetId] = useState(defaultSelection.targetId);

  const options = optionsForInviteLevel(level, { orgs, docos, scopes });
  const noTargets = options.length === 0;

  useEffect(() => {
    if (options.length === 0) {
      if (targetId !== "") setTargetId("");
      return;
    }
    if (!options.some((opt) => opt.id === targetId)) {
      setTargetId(options[0]?.id ?? "");
    }
  }, [options, targetId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a user (human or agent)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <fetcher.Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="invite" />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Level</span>
              <select
                name="level"
                value={level}
                onChange={(e) => {
                  const nextLevel = e.currentTarget.value as InviteLevel;
                  setLevel(nextLevel);
                  const nextOptions = optionsForInviteLevel(nextLevel, { orgs, docos, scopes });
                  setTargetId(nextOptions[0]?.id ?? "");
                }}
                data-testid="invite-level"
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <option value="org">Org</option>
                <option value="doco">Doco</option>
                <option value="scope">Scope</option>
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {level === "org" ? "Organization" : level === "doco" ? "Doco" : "Scope"}
              </span>
              <select
                name="target_id"
                value={targetId}
                onChange={(e) => setTargetId(e.currentTarget.value)}
                disabled={noTargets}
                data-testid="invite-target"
                className="rounded-md border border-border bg-background px-3 py-2 disabled:opacity-50"
              >
                {noTargets ? (
                  <option value="">(no targets you can invite into)</option>
                ) : (
                  options.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Role</span>
              <select
                name="role"
                defaultValue="author"
                data-testid="invite-role"
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="invite-submit"
              disabled={fetcher.state !== "idle" || noTargets}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {fetcher.state !== "idle" ? "Generating…" : "Generate invite link"}
            </button>
          </div>
        </fetcher.Form>

        {error ? (
          <p className="text-sm text-destructive" data-testid="invite-error">
            {error}
          </p>
        ) : null}

        {inviteResult ? (
          <CollaborationInvitePrompt
            inviteUrl={inviteResult.invite_url}
            docoUrl={inviteResult.doco_url}
            recipeUrl={inviteResult.recipe_url}
            deviceUrl={inviteResult.device_url}
            testId="invite-result"
            promptTestId="invite-url"
            copyButtonTestId="invite-copy"
            note={
              <>
                Single-use, expires in 72 hours. Grants{" "}
                <strong>{inviteResult.role}</strong> at the {inviteResult.level} level.
              </>
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
