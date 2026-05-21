// /users — global user-management page (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
// Replaces the per-doco / per-org members pages. Top-level link in
// the host nav. Shows every org/doco grant the signed-in principal
// can see, lets owners edit roles inline (auto-save), and mints
// invite links at either level.

import {
  type DocoRole,
  getDocoById,
  getOrgRole,
  getPrincipalById,
  listDocoIdsForUserPrincipal,
  listDocoUsers,
  listOrganizationsForPrincipal,
  removeDocoUser,
  removeOrgUser,
  upsertDocoUser,
  upsertOrgUser,
  withClient,
} from "@doco/db";
import type { EntityId } from "@doco/shared";
import { useEffect, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { InviteStore } from "~/lib/invite-store.server";
import { getCurrentPrincipal } from "~/lib/session";

const ALL_ROLES: DocoRole[] = ["owner", "approver", "author", "reader"];
type InviteLevel = "org" | "doco";
type InviteOption = { id: string; label: string };
type InviteDefaultSelection = { level: InviteLevel; targetId: string };

function rankOf(role: DocoRole): number {
  return role === "owner" ? 3 : role === "approver" ? 2 : role === "author" ? 1 : 0;
}

function parseInviteLevel(value: string | null): InviteLevel | null {
  return value === "org" || value === "doco" ? value : null;
}

function optionsForInviteLevel(
  level: InviteLevel,
  options: {
    orgs: InviteOption[];
    docos: InviteOption[];
  },
): InviteOption[] {
  if (level === "org") return options.orgs;
  return options.docos;
}

function firstAvailableInviteLevel(options: {
  orgs: InviteOption[];
  docos: InviteOption[];
}): InviteLevel {
  if (options.docos.length > 0) return "doco";
  return "org";
}

function resolveInviteDefaultSelection(args: {
  requestedLevel: InviteLevel | null;
  requestedTargetId: string;
  orgs: InviteOption[];
  docos: InviteOption[];
}): InviteDefaultSelection {
  const level =
    args.requestedLevel ?? firstAvailableInviteLevel({ orgs: args.orgs, docos: args.docos });
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

  // ── Docos the signed-in user has any access to ───────────────────
  // Union of three sources: direct owner_id match, owning org I belong
  // to, and explicit doco_users row. The /users invite picker needs the
  // direct-owner path so freshly-created docos show up before any
  // doco_users row exists.
  const accessibleDocoIds = new Set<string>();
  const directDocos = await withClient((c) =>
    c.query<{ id: string }>("SELECT id FROM docos WHERE owner_id = $1", [me.id]),
  );
  for (const r of directDocos.rows) accessibleDocoIds.add(String(r.id));
  const orgDocos = await withClient((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM docos WHERE owner_id IN (
         SELECT org_id FROM org_users WHERE principal_id = $1
       )`,
      [me.id],
    ),
  );
  for (const r of orgDocos.rows) accessibleDocoIds.add(String(r.id));
  const myDocoUsersIds = await listDocoIdsForUserPrincipal(me.id);
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
    // Effective doco-level role (covers direct owner, org chain, doco_users).
    const myRole =
      (await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id)) ?? "reader";
    docoSections.push({
      doco: { id: doco.id, handle: doco.handle },
      myRole,
      users: enriched,
    });
  }
  docoSections.sort((a, b) => a.doco.handle.localeCompare(b.doco.handle));

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

  return {
    me,
    host: `${url.protocol}//${url.host}`,
    orgSections,
    docoSections,
    invite: {
      orgs: inviteOrgs,
      docos: inviteDocos,
      defaultSelection: resolveInviteDefaultSelection({
        requestedLevel: parseInviteLevel(url.searchParams.get("level")),
        requestedTargetId: url.searchParams.get("target_id")?.trim() ?? "",
        orgs: inviteOrgs,
        docos: inviteDocos,
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
      level: InviteLevel;
      role: DocoRole;
    }
  | {
      intent: "update";
      ok: true;
      level: InviteLevel;
      target_id: string;
      principal_id: string;
      role: DocoRole;
    }
  | {
      intent: "remove";
      ok: true;
      level: InviteLevel;
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
  const level = String(form.get("level") ?? "") as InviteLevel;

  if (intent === "update" || intent === "remove") {
    const targetId = String(form.get("target_id") ?? "").trim();
    const principalId = String(form.get("principal_id") ?? "").trim();
    if (!targetId) return { error: "target_id missing." };
    if (!principalId) return { error: "principal_id missing." };

    // Authorize: actor must be owner at that level. Use getDocoLevelRole
    // for the doco path so direct-owner docos (no doco_users row) pass
    // the check.
    if (level === "org") {
      const role = await getOrgRole(targetId, me.id);
      if (role !== "owner") return { error: "Only org owners can change org users." };
    } else if (level === "doco") {
      const doco = await getDocoById(targetId);
      if (!doco) return { error: "Doco not found." };
      const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
      if (role !== "owner") return { error: "Only doco owners can change doco users." };
    } else {
      return { error: "Invalid level." };
    }

    if (intent === "update") {
      const role = String(form.get("role") ?? "") as DocoRole;
      if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
      if (level === "org")
        await upsertOrgUser({ org_id: targetId, principal_id: principalId, role });
      else await upsertDocoUser({ doco_id: targetId, principal_id: principalId, role });
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
    else await removeDocoUser(targetId, principalId);
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

    if (level === "org") {
      inviterRole = await getOrgRole(targetId, me.id);
      orgId = targetId;
      // We still need a doco_id on the invite for back-links; pick any
      // doco the org owns, falling back to the first one we find.
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
    // Granting/editing access is an owner-only action. Approvers can
    // approve lifecycle changes but can't extend access to others;
    // that's a permission delegation only owners get to do.
    if (inviterRole !== "owner") {
      return {
        error: `Only owners can grant access — you hold '${inviterRole}' on this ${level}.`,
      };
    }
    if (rankOf(role) > rankOf(inviterRole)) {
      return {
        error: `Cannot mint a '${role}' invite — you only hold '${inviterRole}' on this target.`,
      };
    }

    const store = InviteStore.forDoco(rootDir());
    const invite = await store.issueInvite(
      docoId as EntityId<"doco">,
      me.id as EntityId<"principal">,
      3, // 72-hour TTL
      role,
      {
        level,
        ...(orgId ? { org_id: orgId as EntityId<"organization"> } : {}),
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
  host: string;
  orgSections: OrgSection[];
  docoSections: DocoSection[];
  invite: {
    orgs: { id: string; label: string }[];
    docos: { id: string; label: string }[];
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
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Users (people/agents)" })} />
        <header>
          <h1 className="text-2xl font-semibold">Users (people/agents)</h1>
        </header>

        <InviteHumanCard
          orgs={loaderData.invite.orgs}
          docos={loaderData.invite.docos}
          defaultSelection={loaderData.invite.defaultSelection}
        />

        <InviteAgentCard host={loaderData.host} />

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
      </SingleColumnPageMain>
    </div>
  );
}

interface SectionRow {
  level: InviteLevel;
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

/**
 * Two separate cards — humans and agents go through different
 * authentication shapes, so they get their own widgets.
 *
 * Humans: pick (level, target, role) → mint a one-shot invite URL
 * that's bound on the server to that exact grant. The recipient
 * clicks the URL, signs in with GitHub, accepts → they land in
 * doco_users (or org_users) with the role you picked.
 *
 * Agents: there's no scoping form. The agent drives OAuth itself
 * (localhost-loopback or Device Flow), and the human picks which
 * Docos to grant + the per-Doco role on the approve screen at that
 * time. So the agent card is just a static prompt the project owner
 * pastes into their agent runtime — pointing it at the OAuth recipe
 * and at /device for the Device-Flow approval.
 */
function InviteHumanCard({
  orgs,
  docos,
  defaultSelection,
}: {
  orgs: { id: string; label: string }[];
  docos: { id: string; label: string }[];
  defaultSelection: InviteDefaultSelection;
}) {
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data;
  const inviteResult = result && "intent" in result && result.intent === "invite" ? result : null;
  const error = result && "error" in result ? result.error : undefined;
  const [level, setLevel] = useState<InviteLevel>(defaultSelection.level);
  const [targetId, setTargetId] = useState(defaultSelection.targetId);

  const options = optionsForInviteLevel(level, { orgs, docos });
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
        <CardTitle>Invite a human</CardTitle>
        <CardDescription>
          They click the URL, sign in with GitHub, and land in your Doco with the exact role you
          pick.
        </CardDescription>
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
                  const nextOptions = optionsForInviteLevel(nextLevel, { orgs, docos });
                  setTargetId(nextOptions[0]?.id ?? "");
                }}
                data-testid="invite-level"
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <option value="org">Org</option>
                <option value="doco">Doco</option>
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {level === "org" ? "Organization" : "Doco"}
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
            testId="invite-result"
            promptTestId="invite-url"
            copyButtonTestId="invite-copy"
            note={
              <>
                Single-use, expires in 72 hours. Grants <strong>{inviteResult.role}</strong> at the{" "}
                {inviteResult.level} level.
              </>
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function InviteAgentCard({ host }: { host: string }) {
  const recipeUrl = `${host}/protocol/agent-oauth-recipe`;
  const deviceUrl = `${host}/device`;
  const prompt = [
    `Let's collaborate with Doco on this project. The host is ${host}.`,
    "",
    `To get programmatic access, follow the OAuth recipe at ${recipeUrl}. If you can bind a local TCP port and open a browser, use Recipe A (localhost-loopback). If you can't (chat-only / sandboxed runtimes), use Recipe B (RFC 8628 Device Authorization Grant) — you'll show me a short code and I'll approve at ${deviceUrl}.`,
    "",
    "At the approve screen I'll pick which Docos you can read/write and at what role (reader / author / approver / owner) per Doco, so no scoping is needed up front.",
  ].join("\n");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite an AI agent</CardTitle>
        <CardDescription>
          Agents authenticate via OAuth — there's no per-invite scoping here because you pick which
          Docos and what role at approve time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AgentPromptBlock body={prompt} />
      </CardContent>
    </Card>
  );
}

function AgentPromptBlock({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <pre
        className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words"
        data-testid="invite-agent-prompt"
      >
        {body}
      </pre>
      <button
        type="button"
        data-testid="invite-agent-copy"
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(body).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }
        }}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-card"
      >
        {copied ? "Copied!" : "Copy prompt"}
      </button>
    </div>
  );
}
