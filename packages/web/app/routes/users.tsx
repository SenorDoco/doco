// /users — global Collaborators page (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
// Replaces the per-doco / per-workspace members pages. Top-level link in
// the host nav. Lists only accounts with a username — i.e. people —
// across every workspace/doco grant the signed-in principal can see. Agents
// are not collaborators: they authenticate through API tokens and are
// managed on the API Tokens (/api-keys) page, which the invite card
// links to. Lets owners edit roles inline (auto-save) and mint person
// invites in-place via the UserInviteCards card at the top — the prior
// /users/invite standalone page is gone.

import {
  type DocoRole,
  getDocoById,
  getWorkspaceRole,
  removeAccountGrant,
  removeDocoUser,
  removeWorkspaceUser,
  upsertAccountGrant,
  upsertDocoUser,
  upsertWorkspaceUser,
} from "@doco/db";
import { normalizeWriteTypes } from "@doco/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { GrantPicker } from "~/components/grant-picker";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { UserInviteCards } from "~/components/user-invite-cards";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { focusFirstError, validateGrantForm } from "~/lib/grant-form-validation";
import {
  type ComposedGrant,
  type ExistingGrant,
  type GrantCatalog,
  catalogFromOptions,
  resolveWriteTypes,
} from "~/lib/grant-picker";
import { getCurrentPrincipal } from "~/lib/session.server";
import { ALL_ROLES, type InviteLevel, type UserInviteActionResult } from "~/lib/user-invite";
import {
  type GrantRow,
  type UsersPageData,
  handleUserInviteAction,
  loadUsersPageData,
} from "~/lib/users.server";

export async function loader({ request }: { request: Request }) {
  return loadUsersPageData(request);
}

type ActionResult =
  | {
      intent: "update";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      user_id: string;
      role: DocoRole;
      write_types: string[];
    }
  | {
      intent: "remove";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      user_id: string;
    }
  | {
      intent: "add_grants";
      ok: true;
      user_id: string;
      grants_count: number;
    }
  | UserInviteActionResult
  | { error: string };

export async function action({
  request,
}: {
  request: Request;
}): Promise<ActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to manage users." };

  const form = await request.clone().formData();
  const intent = String(form.get("intent") ?? "");
  const level = String(form.get("level") ?? "") as InviteLevel;

  if (intent === "invite") {
    // Delegate to the shared invite handler — same one /api/v1/users/invite.json
    // calls. The InviteHumanCard's useFetcher narrows on `intent === "invite"`
    // so the role-edit cases below don't interfere with it.
    return await handleUserInviteAction(request);
  }

  if (intent === "add_grants") {
    const granteeId = String(form.get("user_id") ?? "").trim();
    if (!granteeId) return { error: "user_id missing." };
    const rawGrants = String(form.get("grants") ?? "").trim();
    if (!rawGrants) return { error: "Pick at least one thing to grant access to." };
    let grants: ComposedGrant[] = [];
    try {
      const parsed = JSON.parse(rawGrants);
      if (!Array.isArray(parsed)) throw new Error("grants must be an array");
      grants = parsed.map(
        (g: { level?: unknown; targetId?: unknown; role?: unknown; writeTypes?: unknown }) => {
          const level =
            g.level === "account" || g.level === "workspace" || g.level === "doco" ? g.level : null;
          const targetId = typeof g.targetId === "string" ? g.targetId : "";
          const role = typeof g.role === "string" ? (g.role as DocoRole) : ("reader" as DocoRole);
          if (!level || (level !== "account" && !targetId) || !ALL_ROLES.includes(role)) {
            throw new Error("invalid grant entry");
          }
          const writeTypes = Array.isArray(g.writeTypes)
            ? g.writeTypes.filter((t): t is string => typeof t === "string")
            : [];
          return { level, targetId, role, writeTypes };
        },
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Malformed grants list." };
    }

    for (const grant of grants) {
      const write_types = normalizeWriteTypes(resolveWriteTypes(grant.role, grant.writeTypes));
      if (grant.level === "account") {
        if (granteeId === me.id) return { error: "You can't grant your account to yourself." };
        await upsertAccountGrant({
          grantor_user_id: me.id,
          grantee_user_id: granteeId,
          role: grant.role,
          write_types,
        });
      } else if (grant.level === "workspace") {
        const role = await getWorkspaceRole(grant.targetId, me.id);
        if (role !== "owner") return { error: "Only workspace owners can change workspace users." };
        await upsertWorkspaceUser({
          workspace_id: grant.targetId,
          user_id: granteeId,
          role: grant.role,
          write_types,
        });
      } else {
        const doco = await getDocoById(grant.targetId);
        if (!doco) return { error: "Doco not found." };
        const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
        if (role !== "owner") return { error: "Only doco owners can change doco users." };
        await upsertDocoUser({
          doco_id: grant.targetId,
          user_id: granteeId,
          role: grant.role,
          write_types,
        });
      }
    }

    return { intent: "add_grants", ok: true, user_id: granteeId, grants_count: grants.length };
  }

  // Account-level grants: the grantor is the acting user, so there is
  // no target to own-check — you may always grant or revoke access to
  // your OWN account. The per-type set + role mirror the doco/workspace cases.
  if ((intent === "update" || intent === "remove") && level === "account") {
    const granteeId = String(form.get("user_id") ?? "").trim();
    if (!granteeId) return { error: "user_id missing." };
    if (granteeId === me.id) return { error: "You can't grant your account to yourself." };
    if (intent === "remove") {
      await removeAccountGrant(me.id, granteeId);
      return { intent: "remove", ok: true, level, target_ids: [], user_id: granteeId };
    }
    const role = String(form.get("role") ?? "") as DocoRole;
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    const rawWriteTypes = form.get("write_types");
    const write_types =
      rawWriteTypes === null
        ? undefined
        : normalizeWriteTypes(
            String(rawWriteTypes)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
    await upsertAccountGrant({
      grantor_user_id: me.id,
      grantee_user_id: granteeId,
      role,
      write_types,
    });
    return {
      intent: "update",
      ok: true,
      level,
      target_ids: [],
      user_id: granteeId,
      role,
      write_types: write_types ?? (role === "writer" ? ["*"] : []),
    };
  }

  if (intent === "update" || intent === "remove") {
    // target_ids is comma-separated when a grouped row covers multiple grants.
    const rawTargets = String(form.get("target_ids") ?? "").trim();
    const targetIds = rawTargets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const principalId = String(form.get("user_id") ?? "").trim();
    if (targetIds.length === 0) return { error: "target_ids missing." };
    if (!principalId) return { error: "user_id missing." };

    if (level !== "workspace" && level !== "doco") return { error: "Invalid level." };

    for (const targetId of targetIds) {
      if (level === "workspace") {
        const role = await getWorkspaceRole(targetId, me.id);
        if (role !== "owner") return { error: "Only workspace owners can change workspace users." };
      } else {
        const doco = await getDocoById(targetId);
        if (!doco) return { error: "Doco not found." };
        const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
        if (role !== "owner") return { error: "Only doco owners can change doco users." };
      }
    }

    if (intent === "update") {
      const role = String(form.get("role") ?? "") as DocoRole;
      if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
      // Optional per-type write set (decision_per_type_write_grants),
      // comma-separated type tokens or "*". Absent → upsert defaults
      // (wildcard for a writer, empty otherwise), preserving the old
      // whole-Doco behavior for callers that don't send it.
      const rawWriteTypes = form.get("write_types");
      const write_types =
        rawWriteTypes === null
          ? undefined
          : normalizeWriteTypes(
              String(rawWriteTypes)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            );
      for (const targetId of targetIds) {
        if (level === "workspace")
          await upsertWorkspaceUser({
            workspace_id: targetId,
            user_id: principalId,
            role,
            write_types,
          });
        else await upsertDocoUser({ doco_id: targetId, user_id: principalId, role, write_types });
      }
      return {
        intent: "update",
        ok: true,
        level,
        target_ids: targetIds,
        user_id: principalId,
        role,
        write_types: write_types ?? (role === "writer" ? ["*"] : []),
      };
    }
    for (const targetId of targetIds) {
      if (level === "workspace") await removeWorkspaceUser(targetId, principalId);
      else await removeDocoUser(targetId, principalId);
    }
    return {
      intent: "remove",
      ok: true,
      level,
      target_ids: targetIds,
      user_id: principalId,
    };
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Collaborators · Doco" }];
}

interface AccessGrant {
  target_id: string;
  target_label: string;
  target_link: string;
  joined_at: string;
  role: DocoRole;
  writeTypes: string[];
  canEdit: boolean;
}

interface GroupedRow {
  level: InviteLevel;
  principal: GrantRow;
  grants: AccessGrant[];
  canEditAny: boolean;
  earliestJoinedAt: string;
}

// Aggregate by principal — each row carries every (target, role) the
// principal holds at this level. The chip+role+remove controls render
// per grant since role can vary across targets.
function groupByPrincipal(rows: GroupedRow[]): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const row of rows) {
    const key = row.principal.user_id;
    const existing = map.get(key);
    if (existing) {
      existing.grants.push(...row.grants);
      existing.canEditAny = existing.canEditAny || row.canEditAny;
      if (row.earliestJoinedAt < existing.earliestJoinedAt) {
        existing.earliestJoinedAt = row.earliestJoinedAt;
      }
    } else {
      map.set(key, { ...row, grants: [...row.grants] });
    }
  }
  for (const row of map.values()) {
    row.grants.sort((a, b) => a.target_label.localeCompare(b.target_label));
  }
  return [...map.values()].sort((a, b) => a.principal.username.localeCompare(b.principal.username));
}

export default function UsersPage({
  loaderData,
}: {
  loaderData: UsersPageData;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Scope filter: "all" | "workspace:<id>" | "doco:<id>".
  const scope = searchParams.get("scope") ?? "all";

  function applyScope(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("scope");
    else next.set("scope", value);
    // Filtering in place — keep the reader's scroll position. preventScrollReset
    // is mirrored into history state for the custom main-pane scroll restorer.
    setSearchParams(next, {
      replace: true,
      preventScrollReset: true,
      state: { preventScrollReset: true },
    });
  }

  const workspaceRows = useMemo(() => {
    const flat: GroupedRow[] = loaderData.workspaceSections
      .filter((s) => scope === "all" || scope === `workspace:${s.workspace.id}`)
      .flatMap((s) =>
        s.users.map<GroupedRow>((u) => ({
          level: "workspace",
          principal: u,
          grants: [
            {
              target_id: s.workspace.id,
              target_label: s.workspace.handle,
              target_link: `/workspaces/${s.workspace.handle}`,
              joined_at: u.joined_at,
              role: u.role,
              writeTypes: u.write_types,
              canEdit: s.myRole === "owner",
            },
          ],
          canEditAny: s.myRole === "owner",
          earliestJoinedAt: u.joined_at,
        })),
      );
    return groupByPrincipal(flat);
  }, [loaderData.workspaceSections, scope]);

  const docoRows = useMemo(() => {
    const flat: GroupedRow[] = loaderData.docoSections
      .filter(
        (s) =>
          scope === "all" ||
          scope === `doco:${s.doco.id}` ||
          // When an workspace is selected, also surface collaborators on the
          // docos that workspace owns — not just the workspace-wide grants.
          scope === `workspace:${s.doco.ownerId}`,
      )
      .flatMap((s) =>
        s.users.map<GroupedRow>((u) => ({
          level: "doco",
          principal: u,
          grants: [
            {
              target_id: s.doco.id,
              target_label: s.doco.label,
              target_link: `/${s.doco.handle}`,
              joined_at: u.joined_at,
              role: u.role,
              writeTypes: u.write_types,
              canEdit: s.myRole === "owner",
            },
          ],
          canEditAny: s.myRole === "owner",
          earliestJoinedAt: u.joined_at,
        })),
      );
    return groupByPrincipal(flat);
  }, [loaderData.docoSections, scope]);

  // "All" and workspace scopes show both sections — selecting an workspace surfaces
  // its workspace-wide grants AND the per-doco grants on docos it owns. A doco
  // scope shows only the per-doco section.
  const showWorkspaceSection = scope === "all" || scope.startsWith("workspace:");
  const showDocoSection =
    scope === "all" || scope.startsWith("doco:") || scope.startsWith("workspace:");
  const docoSectionEmpty = scope.startsWith("workspace:")
    ? "No collaborators on docos in this workspace yet."
    : "You don't have any doco grants yet.";
  const grantCatalog = useMemo(() => catalogFromInvite(loaderData.invite), [loaderData.invite]);
  const existingByPrincipal = useMemo(() => existingGrantsByPrincipal(loaderData), [loaderData]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader me={loaderData.me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Collaborators" })} />
        <header>
          <h1 className="text-2xl font-semibold">Collaborators</h1>
        </header>

        <Card>
          <CardContent className="pt-4">
            <UserInviteCards invite={loaderData.invite} />
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-base font-semibold">Show collaborators for</span>
            <select
              value={scope}
              onChange={(e) => applyScope(e.currentTarget.value)}
              data-testid="scope-filter"
              className="w-auto rounded-md px-3 py-2"
            >
              <option value="all">All collaborators</option>
              {loaderData.workspaceSections.length > 0 ? (
                <optgroup label="By workspace">
                  {loaderData.workspaceSections.map((s) => (
                    <option key={s.workspace.id} value={`workspace:${s.workspace.id}`}>
                      {s.workspace.handle}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {loaderData.docoSections.length > 0 ? (
                <optgroup label="By doco">
                  {loaderData.docoSections.map((s) => (
                    <option key={s.doco.id} value={`doco:${s.doco.id}`}>
                      {s.doco.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        </div>

        {showWorkspaceSection ? (
          <Section
            title="Workspace-wide collaborators"
            empty="You don't have any workspace grants yet."
            rows={workspaceRows}
            myPrincipalId={loaderData.me.id}
            grantCatalog={grantCatalog}
            existingByPrincipal={existingByPrincipal}
          />
        ) : null}

        {showDocoSection ? (
          <Section
            title="Per-doco collaborators"
            empty={docoSectionEmpty}
            rows={docoRows}
            myPrincipalId={loaderData.me.id}
            grantCatalog={grantCatalog}
            existingByPrincipal={existingByPrincipal}
          />
        ) : null}
      </SingleColumnPageMain>
    </div>
  );
}

function Section({
  title,
  empty,
  rows,
  myPrincipalId,
  grantCatalog,
  existingByPrincipal,
}: {
  title: string;
  empty: string;
  rows: GroupedRow[];
  myPrincipalId: string;
  grantCatalog: GrantCatalog;
  existingByPrincipal: Map<string, ExistingGrant[]>;
}) {
  const sorted = [...rows].sort(activeFirst);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        {sorted.length === 0 ? (
          <p className="pt-2 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[55%]" />
                <col className="w-[45%]" />
              </colgroup>
              <tbody className="divide-y divide-border">
                {sorted.map((r) => (
                  <UserRow
                    key={`${r.level}-${r.principal.user_id}`}
                    row={r}
                    myPrincipalId={myPrincipalId}
                    grantCatalog={grantCatalog}
                    existing={existingByPrincipal.get(r.principal.user_id) ?? []}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Most-recently-active first. Rows with no recorded activity sink to the
// bottom; ties break alphabetically by username.
function activeFirst(a: GroupedRow, b: GroupedRow): number {
  const at = a.principal.last_activity_at
    ? Date.parse(a.principal.last_activity_at)
    : Number.NEGATIVE_INFINITY;
  const bt = b.principal.last_activity_at
    ? Date.parse(b.principal.last_activity_at)
    : Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  return a.principal.username.localeCompare(b.principal.username);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function UserRow({
  row,
  myPrincipalId,
  grantCatalog,
  existing,
}: {
  row: GroupedRow;
  myPrincipalId: string;
  grantCatalog: GrantCatalog;
  existing: ExistingGrant[];
}) {
  const username = row.principal.username;
  const isMe = row.principal.user_id === myPrincipalId;

  const grantedAbs = formatDate(row.earliestJoinedAt);
  const grantedRel = formatRelative(row.earliestJoinedAt);
  const lastActive = formatRelative(row.principal.last_activity_at);
  const metaParts: string[] = [];
  metaParts.push(`Granted ${grantedRel}`);
  metaParts.push(`Active ${lastActive}`);
  const metaTooltip = `Granted ${grantedAbs}${row.principal.last_activity_at ? ` · Last active ${row.principal.last_activity_at}` : ""}`;

  // Master-detail: the row lists the collaborator and a summary; the
  // per-grant access controls are hidden behind a "View access" toggle so
  // the list isn't a wall of inline permissions.
  const [open, setOpen] = useState(false);
  const grantCount = row.grants.length;
  const accessSummary =
    grantCount === 1
      ? `${describeRole(row.grants[0]?.role)} on ${row.grants[0]?.target_label}`
      : `${grantCount} ${row.level === "workspace" ? "workspace" : "doco"} grant${grantCount === 1 ? "" : "s"}`;

  return (
    <>
      <tr data-testid={`row-${row.level}-${username}`}>
        <td className="py-3 pr-3 align-top">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium" title={username}>
              {username}
            </span>
            {isMe ? (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                you
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground" title={metaTooltip}>
            {metaParts.join(" · ")}
          </div>
        </td>
        <td className="py-3 align-top">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{accessSummary}</span>
            <button
              type="button"
              data-testid={`view-access-${row.level}-${username}`}
              onClick={() => setOpen((v) => !v)}
              className="shrink-0 text-sm font-semibold text-primary underline-offset-4 hover:underline"
              aria-expanded={open}
            >
              {open ? "Hide access" : "View access"}
            </button>
          </div>
        </td>
      </tr>
      {open ? (
        <tr data-testid={`row-detail-${row.level}-${username}`}>
          <td colSpan={2} className="pb-4 pl-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Access details
            </div>
            <div className="mt-1 flex flex-col gap-1.5">
              {row.grants.map((g) => (
                <AccessLine
                  key={g.target_id}
                  level={row.level}
                  principalId={row.principal.user_id}
                  username={username}
                  grant={g}
                  isMe={isMe}
                />
              ))}
              {row.canEditAny ? (
                <AddUserAccessForm
                  principalId={row.principal.user_id}
                  username={username}
                  catalog={grantCatalog}
                  existing={existing}
                />
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function catalogFromInvite(invite: UsersPageData["invite"]): GrantCatalog {
  return catalogFromOptions(invite.workspaces, invite.docos);
}

function existingGrantsByPrincipal(data: UsersPageData): Map<string, ExistingGrant[]> {
  const out = new Map<string, ExistingGrant[]>();
  const push = (userId: string, grant: ExistingGrant) => {
    const current = out.get(userId);
    if (current) current.push(grant);
    else out.set(userId, [grant]);
  };
  for (const section of data.workspaceSections) {
    for (const user of section.users) {
      push(user.user_id, {
        level: "workspace",
        targetId: section.workspace.id,
        label: section.workspace.handle,
        role: user.role,
        writeTypes: user.write_types,
      });
    }
  }
  for (const section of data.docoSections) {
    for (const user of section.users) {
      push(user.user_id, {
        level: "doco",
        targetId: section.doco.id,
        label: section.doco.label,
        role: user.role,
        writeTypes: user.write_types,
      });
    }
  }
  return out;
}

function AddUserAccessForm({
  principalId,
  username,
  catalog,
  existing,
}: {
  principalId: string;
  username: string;
  catalog: GrantCatalog;
  existing: ExistingGrant[];
}) {
  const fetcher = useFetcher<ActionResult>();
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<ComposedGrant[]>([]);
  const [grantError, setGrantError] = useState<string | null>(null);
  const grantsRef = useRef<HTMLDivElement>(null);
  const done =
    fetcher.state === "idle" &&
    fetcher.data &&
    "intent" in fetcher.data &&
    fetcher.data.intent === "add_grants";
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  useEffect(() => {
    if (done) {
      setGrants([]);
      setOpen(false);
    }
  }, [done]);
  const payload = useMemo(() => JSON.stringify(grants), [grants]);

  // Submit stays clickable so an empty selection explains itself rather than
  // doing nothing.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const found = validateGrantForm({ grantCount: grants.length });
    if (found.length === 0) {
      setGrantError(null);
      return;
    }
    e.preventDefault();
    setGrantError(found[0].message);
    focusFirstError("grants", { grants: grantsRef.current });
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`add-user-access-${principalId}`}
        onClick={() => setOpen(true)}
        className="neu-button mt-2 w-fit rounded-md px-2 py-1 text-xs"
      >
        Modify access
      </button>
    );
  }

  return (
    <fetcher.Form
      method="post"
      onSubmit={handleSubmit}
      className="mt-2 space-y-3 rounded-md border border-border p-3"
      data-testid={`add-user-access-form-${principalId}`}
    >
      <input type="hidden" name="intent" value="add_grants" />
      <input type="hidden" name="user_id" value={principalId} />
      <input type="hidden" name="grants" value={payload} />
      <div ref={grantsRef}>
        <GrantPicker
          catalog={catalog}
          grants={grants}
          onChange={(next) => {
            setGrants(next);
            if (next.length > 0) setGrantError(null);
          }}
          existing={existing}
        />
        {grantError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {grantError}
          </p>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setGrants([]);
            setGrantError(null);
            setOpen(false);
          }}
          className="neu-button rounded-md px-2 py-1 text-xs"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="neu-button bg-primary text-primary-foreground rounded-md px-2 py-1 text-xs font-semibold disabled:opacity-50"
        >
          {fetcher.state !== "idle" ? "Saving…" : `Save access changes for ${username}`}
        </button>
      </div>
    </fetcher.Form>
  );
}

function describeRole(role: DocoRole | undefined): string {
  if (role === "owner") return "Owner";
  if (role === "writer") return "Writer";
  return "Reader";
}

function AccessLine({
  level,
  principalId,
  username,
  grant,
  isMe,
}: {
  level: InviteLevel;
  principalId: string;
  username: string;
  grant: AccessGrant;
  isMe: boolean;
}) {
  const roleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();

  const updatePayload = (newRole: string): Record<string, string> => ({
    intent: "update",
    level,
    target_ids: grant.target_id,
    role: newRole,
    user_id: principalId,
  });
  const removePayload: Record<string, string> = {
    intent: "remove",
    level,
    target_ids: grant.target_id,
    user_id: principalId,
  };

  const error =
    roleFetcher.data && "error" in roleFetcher.data ? roleFetcher.data.error : undefined;
  const justSaved =
    roleFetcher.state === "idle" &&
    roleFetcher.data &&
    "intent" in roleFetcher.data &&
    roleFetcher.data.intent === "update";
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (justSaved) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [justSaved]);

  return (
    // pr-2 + pb-1 give the right-most / bottom-most .neu-button room
    // for its 5px+12px shadow to render fully — without it, the X
    // button at the row's end gets visually clipped against the
    // table-cell edge (see `.neu-button` render contract in app.css).
    <div className="flex items-center gap-2 pb-1 pr-2">
      <Link
        to={grant.target_link}
        className="neu-button inline-flex min-w-0 flex-1 items-center truncate rounded-full px-2 py-0.5 text-xs"
        title={`${grant.target_label} — granted ${formatDate(grant.joined_at)}`}
      >
        {grant.target_label}
      </Link>
      <select
        defaultValue={grant.role}
        disabled={!grant.canEdit || roleFetcher.state !== "idle"}
        data-testid={`role-${level}-${username}-${grant.target_id}`}
        className="rounded-md px-1.5 py-0.5 text-xs disabled:opacity-50"
        onChange={(e) => {
          roleFetcher.submit(updatePayload(e.currentTarget.value), { method: "post" });
        }}
      >
        {ALL_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {grant.canEdit ? (
        <button
          type="button"
          disabled={removeFetcher.state !== "idle"}
          data-testid={`remove-${level}-${username}-${grant.target_id}`}
          onClick={() => {
            if (isMe) {
              // Removing yourself is destructive in a way removing other
              // people isn't: it cuts your own access immediately, and
              // you can't undo it from this UI — you'd need someone else
              // with owner on the target to invite you back. Force a
              // typed confirmation so it can't happen by reflex.
              const warning = [
                `⚠ You're about to remove YOURSELF from ${grant.target_label}.`,
                "",
                "Effect (immediate, no undo from this screen):",
                `  • You lose your ${grant.role} grant on this ${level}.`,
                `  • You may lose access to ${grant.target_label} entirely.`,
                "  • Only another owner can invite you back.",
                "",
                `Type the ${level} handle (${grant.target_label}) to confirm:`,
              ].join("\n");
              const typed = prompt(warning, "");
              if (typed?.trim() !== grant.target_label) return;
            } else {
              if (!confirm(`Remove ${username} from ${grant.target_label}?`)) return;
            }
            removeFetcher.submit(removePayload, { method: "post" });
          }}
          title={
            isMe
              ? `Remove yourself from ${grant.target_label} (requires typed confirmation)`
              : `Remove ${username} from ${grant.target_label}`
          }
          className="neu-button shrink-0 rounded-md px-1.5 py-0.5 text-xs text-destructive disabled:opacity-50"
        >
          {removeFetcher.state !== "idle" ? "…" : "×"}
        </button>
      ) : null}
      {roleFetcher.state !== "idle" || error || showSaved ? (
        <span className="text-[10px] text-muted-foreground" aria-live="polite">
          {roleFetcher.state !== "idle" ? (
            "Saving…"
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            "Saved"
          )}
        </span>
      ) : null}
    </div>
  );
}
