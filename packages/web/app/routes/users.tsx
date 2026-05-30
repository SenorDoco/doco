// /users — global Collaborators page (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
// Replaces the per-doco / per-org members pages. Top-level link in
// the host nav. Lists only accounts with a username — i.e. people —
// across every org/doco grant the signed-in principal can see. Agents
// are not collaborators: they authenticate through API tokens and are
// managed on the API Tokens (/api-keys) page, which the invite card
// links to. Lets owners edit roles inline (auto-save) and mint person
// invites in-place via the UserInviteCards card at the top — the prior
// /users/invite standalone page is gone.

import {
  type DocoRole,
  getDocoById,
  getOrgRole,
  removeDocoUser,
  removeOrgUser,
  upsertDocoUser,
  upsertOrgUser,
} from "@doco/db";
import { normalizeWriteTypes } from "@doco/shared";
import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { UserInviteCards } from "~/components/user-invite-cards";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { ALL_ROLES, type InviteLevel, type UserInviteActionResult } from "~/lib/user-invite";
import {
  type GrantRow,
  type UsersPageData,
  handleUserInviteAction,
  loadUsersPageData,
  renameAgentCollaborator,
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
      intent: "rename";
      ok: true;
      user_id: string;
      username: string;
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

  if (intent === "rename") {
    const agentId = String(form.get("user_id") ?? "").trim();
    const name = String(form.get("name") ?? "");
    if (!agentId) return { error: "user_id missing." };
    return await renameAgentCollaborator({ meId: me.id, agentId, name });
  }

  if (intent === "update" || intent === "remove") {
    // target_ids is the canonical field — comma-separated when a grouped
    // row covers multiple grants. Falls back to legacy target_id.
    const rawTargets = String(form.get("target_ids") ?? form.get("target_id") ?? "").trim();
    const targetIds = rawTargets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const principalId = String(form.get("user_id") ?? "").trim();
    if (targetIds.length === 0) return { error: "target_ids missing." };
    if (!principalId) return { error: "user_id missing." };

    if (level !== "org" && level !== "doco") return { error: "Invalid level." };

    for (const targetId of targetIds) {
      if (level === "org") {
        const role = await getOrgRole(targetId, me.id);
        if (role !== "owner") return { error: "Only org owners can change org users." };
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
        if (level === "org")
          await upsertOrgUser({ org_id: targetId, user_id: principalId, role, write_types });
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
      if (level === "org") await removeOrgUser(targetId, principalId);
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

  // Scope filter: "all" | "org:<id>" | "doco:<id>". Legacy
  // ?level=&target_id= URLs still arrive filtered to that scope.
  const explicitScope = searchParams.get("scope");
  const legacyLevel = searchParams.get("level");
  const legacyTargetId = searchParams.get("target_id");
  const scope =
    explicitScope ?? (legacyLevel && legacyTargetId ? `${legacyLevel}:${legacyTargetId}` : "all");

  function applyScope(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("scope");
    else next.set("scope", value);
    next.delete("level");
    next.delete("target_id");
    setSearchParams(next, { replace: true });
  }

  const orgRows = useMemo(() => {
    const flat: GroupedRow[] = loaderData.orgSections
      .filter((s) => scope === "all" || scope === `org:${s.org.id}`)
      .flatMap((s) =>
        s.users.map<GroupedRow>((u) => ({
          level: "org",
          principal: u,
          grants: [
            {
              target_id: s.org.id,
              target_label: s.org.handle,
              target_link: `/orgs/${s.org.handle}`,
              joined_at: u.joined_at,
              role: u.role,
              canEdit: s.myRole === "owner",
            },
          ],
          canEditAny: s.myRole === "owner",
          earliestJoinedAt: u.joined_at,
        })),
      );
    return groupByPrincipal(flat);
  }, [loaderData.orgSections, scope]);

  const docoRows = useMemo(() => {
    const flat: GroupedRow[] = loaderData.docoSections
      .filter(
        (s) =>
          scope === "all" ||
          scope === `doco:${s.doco.id}` ||
          // When an org is selected, also surface collaborators on the
          // docos that org owns — not just the org-wide grants.
          scope === `org:${s.doco.ownerId}`,
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
              canEdit: s.myRole === "owner",
            },
          ],
          canEditAny: s.myRole === "owner",
          earliestJoinedAt: u.joined_at,
        })),
      );
    return groupByPrincipal(flat);
  }, [loaderData.docoSections, scope]);

  // "All" and org scopes show both sections — selecting an org surfaces
  // its org-wide grants AND the per-doco grants on docos it owns. A doco
  // scope shows only the per-doco section.
  const showOrgSection = scope === "all" || scope.startsWith("org:");
  const showDocoSection = scope === "all" || scope.startsWith("doco:") || scope.startsWith("org:");
  const docoSectionEmpty = scope.startsWith("org:")
    ? "No collaborators on docos in this org yet."
    : "You don't have any doco grants yet.";

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Collaborators" })} />
        <header>
          <h1 className="text-2xl font-semibold">Collaborators</h1>
        </header>

        <Card>
          <CardContent className="pt-4">
            <UserInviteCards invite={loaderData.invite} host={loaderData.host} />
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
              {loaderData.orgSections.length > 0 ? (
                <optgroup label="By org">
                  {loaderData.orgSections.map((s) => (
                    <option key={s.org.id} value={`org:${s.org.id}`}>
                      {s.org.handle}
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

        {showOrgSection ? (
          <Section
            title="Org-wide collaborators"
            empty="You don't have any org grants yet."
            rows={orgRows}
            myPrincipalId={loaderData.me.id}
          />
        ) : null}

        {showDocoSection ? (
          <Section
            title="Per-doco collaborators"
            empty={docoSectionEmpty}
            rows={docoRows}
            myPrincipalId={loaderData.me.id}
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
}: {
  title: string;
  empty: string;
  rows: GroupedRow[];
  myPrincipalId: string;
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
}: {
  row: GroupedRow;
  myPrincipalId: string;
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

  // Owners of the org an agent's token belongs to can give it a
  // human-readable name (agents otherwise show their raw user id).
  const canRename = row.level === "org" && row.principal.kind === "agent" && row.canEditAny;

  // Master-detail: the row lists the collaborator and a summary; the
  // per-grant access controls are hidden behind a "View access" toggle so
  // the list isn't a wall of inline permissions.
  const [open, setOpen] = useState(false);
  const grantCount = row.grants.length;
  const accessSummary =
    grantCount === 1
      ? `${describeRole(row.grants[0]?.role)} on ${row.grants[0]?.target_label}`
      : `${grantCount} ${row.level === "org" ? "org" : "doco"} grant${grantCount === 1 ? "" : "s"}`;

  return (
    <>
      <tr data-testid={`row-${row.level}-${username}`}>
        <td className="py-3 pr-3 align-top">
          <div className="flex items-center gap-1.5">
            {canRename ? (
              <RenameAgentName principalId={row.principal.user_id} username={username} />
            ) : (
              <span className="truncate font-medium" title={username}>
                {username}
              </span>
            )}
            {isMe ? (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                you
              </span>
            ) : null}
            {row.principal.kind === "agent" ? (
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                agent
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
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function describeRole(role: DocoRole | undefined): string {
  if (role === "owner") return "Owner";
  if (role === "writer") return "Writer";
  return "Reader";
}

function RenameAgentName({
  principalId,
  username,
}: {
  principalId: string;
  username: string;
}) {
  const fetcher = useFetcher<ActionResult>();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(username);
  const saving = fetcher.state !== "idle";
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  const justRenamed =
    fetcher.state === "idle" &&
    fetcher.data &&
    "intent" in fetcher.data &&
    fetcher.data.intent === "rename";

  // Close the editor once the rename lands; the loader revalidation
  // repaints the row with the new name.
  useEffect(() => {
    if (justRenamed) setEditing(false);
  }, [justRenamed]);

  const submit = () => {
    if (!value.trim()) return;
    fetcher.submit({ intent: "rename", user_id: principalId, name: value }, { method: "post" });
  };

  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium" title={username}>
          {username}
        </span>
        <button
          type="button"
          data-testid={`rename-${principalId}`}
          onClick={() => {
            setValue(username);
            setEditing(true);
          }}
          title="Rename this agent"
          className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground underline hover:text-foreground"
        >
          rename
        </button>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      <input
        type="text"
        value={value}
        // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
        autoFocus
        maxLength={120}
        disabled={saving}
        data-testid={`rename-input-${principalId}`}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-xs font-medium disabled:opacity-50"
      />
      <button
        type="button"
        disabled={saving || !value.trim()}
        data-testid={`rename-save-${principalId}`}
        onClick={submit}
        className="neu-button shrink-0 rounded-md px-1.5 py-0.5 text-[10px] disabled:opacity-50"
      >
        {saving ? "…" : "Save"}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => setEditing(false)}
        className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
      >
        Cancel
      </button>
      {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
    </span>
  );
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
