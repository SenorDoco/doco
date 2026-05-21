// /collaborators — global collaborator-management page (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
// Replaces the per-doco / per-org members pages. Top-level link in
// the host nav. Shows every org/doco grant the signed-in principal
// can see, lets owners edit roles inline (auto-save), and links to
// the standalone collaborator-invite page.

import {
  type DocoRole,
  getDocoById,
  getOrgRole,
  removeDocoUser,
  removeOrgUser,
  upsertDocoUser,
  upsertOrgUser,
  withClient,
} from "@doco/db";
import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { ALL_ROLES, type InviteLevel } from "~/lib/collaborator-invite";
import {
  type CollaboratorsPageData,
  type GrantRow,
  loadCollaboratorsPageData,
} from "~/lib/collaborators.server";
import { getDocoLevelRole } from "~/lib/doco-access.server";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader({ request }: { request: Request }) {
  return loadCollaboratorsPageData(request);
}

type ActionResult =
  | {
      intent: "update";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      principal_id: string;
      role: DocoRole;
    }
  | {
      intent: "remove";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      principal_id: string;
    }
  | {
      intent: "oauth_update";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      client_id: string;
      role: DocoRole;
    }
  | {
      intent: "oauth_remove";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      client_id: string;
    }
  | { error: string };

export async function action({
  request,
}: {
  request: Request;
}): Promise<ActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to manage collaborators." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const level = String(form.get("level") ?? "") as InviteLevel;

  if (intent === "update" || intent === "remove") {
    // target_ids is the canonical field — comma-separated when a grouped
    // row covers multiple grants. Falls back to legacy target_id.
    const rawTargets = String(form.get("target_ids") ?? form.get("target_id") ?? "").trim();
    const targetIds = rawTargets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const principalId = String(form.get("principal_id") ?? "").trim();
    if (targetIds.length === 0) return { error: "target_ids missing." };
    if (!principalId) return { error: "principal_id missing." };

    if (level !== "org" && level !== "doco") return { error: "Invalid level." };

    for (const targetId of targetIds) {
      if (level === "org") {
        const role = await getOrgRole(targetId, me.id);
        if (role !== "owner") return { error: "Only org owners can change org collaborators." };
      } else {
        const doco = await getDocoById(targetId);
        if (!doco) return { error: "Doco not found." };
        const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
        if (role !== "owner") return { error: "Only doco owners can change doco collaborators." };
      }
    }

    if (intent === "update") {
      const role = String(form.get("role") ?? "") as DocoRole;
      if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
      for (const targetId of targetIds) {
        if (level === "org")
          await upsertOrgUser({ org_id: targetId, principal_id: principalId, role });
        else await upsertDocoUser({ doco_id: targetId, principal_id: principalId, role });
      }
      return { intent: "update", ok: true, level, target_ids: targetIds, principal_id: principalId, role };
    }
    for (const targetId of targetIds) {
      if (level === "org") await removeOrgUser(targetId, principalId);
      else await removeDocoUser(targetId, principalId);
    }
    return { intent: "remove", ok: true, level, target_ids: targetIds, principal_id: principalId };
  }

  if (intent === "oauth_update" || intent === "oauth_remove") {
    const rawTargets = String(form.get("target_ids") ?? "").trim();
    const targetIds = rawTargets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const clientId = String(form.get("client_id") ?? "").trim();
    if (targetIds.length === 0) return { error: "target_ids missing." };
    if (!clientId) return { error: "client_id missing." };
    if (level !== "org" && level !== "doco") return { error: "Invalid level." };

    // Auth: only owners on each target can manage agent grants on it.
    for (const targetId of targetIds) {
      if (level === "org") {
        const role = await getOrgRole(targetId, me.id);
        if (role !== "owner") return { error: "Only org owners can change agent grants." };
      } else {
        const doco = await getDocoById(targetId);
        if (!doco) return { error: "Doco not found." };
        const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
        if (role !== "owner") return { error: "Only doco owners can change agent grants." };
      }
    }

    const idsCol = level === "org" ? "granted_org_ids" : "granted_doco_ids";
    const rolesCol = level === "org" ? "granted_org_roles" : "granted_doco_roles";

    if (intent === "oauth_update") {
      const role = String(form.get("role") ?? "") as DocoRole;
      if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
      for (const targetId of targetIds) {
        await withClient(async (c) => {
          await c.query(
            `UPDATE oauth_access_tokens
                SET ${rolesCol} = jsonb_set(${rolesCol}, ARRAY[$3], to_jsonb($4::text), true)
              WHERE principal_id = $1 AND client_id = $2 AND revoked = false
                AND $3 = ANY(${idsCol})`,
            [me.id, clientId, targetId, role],
          );
          await c.query(
            `UPDATE oauth_refresh_tokens
                SET ${rolesCol} = jsonb_set(${rolesCol}, ARRAY[$3], to_jsonb($4::text), true)
              WHERE principal_id = $1 AND client_id = $2 AND revoked = false
                AND $3 = ANY(${idsCol})`,
            [me.id, clientId, targetId, role],
          );
        });
      }
      return {
        intent: "oauth_update",
        ok: true,
        level,
        target_ids: targetIds,
        client_id: clientId,
        role,
      };
    }

    for (const targetId of targetIds) {
      await withClient(async (c) => {
        await c.query(
          `UPDATE oauth_access_tokens
              SET ${idsCol}   = array_remove(${idsCol}, $3),
                  ${rolesCol} = ${rolesCol} - $3
            WHERE principal_id = $1 AND client_id = $2 AND revoked = false`,
          [me.id, clientId, targetId],
        );
        await c.query(
          `UPDATE oauth_refresh_tokens
              SET ${idsCol}   = array_remove(${idsCol}, $3),
                  ${rolesCol} = ${rolesCol} - $3
            WHERE principal_id = $1 AND client_id = $2 AND revoked = false`,
          [me.id, clientId, targetId],
        );
      });
    }
    return {
      intent: "oauth_remove",
      ok: true,
      level,
      target_ids: targetIds,
      client_id: clientId,
    };
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Collaborators · Doco" }];
}

interface TargetRef {
  id: string;
  label: string;
  link: string;
  canEdit: boolean;
  joined_at: string;
}

interface GroupedRow {
  level: InviteLevel;
  principal: GrantRow;
  role: DocoRole;
  targets: TargetRef[];
  canEditAll: boolean;
  earliestJoinedAt: string;
}

function groupRows(rows: GroupedRow[]): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const row of rows) {
    const key = `${row.principal.principal_id}::${row.role}`;
    const existing = map.get(key);
    if (existing) {
      existing.targets.push(...row.targets);
      existing.canEditAll = existing.canEditAll && row.canEditAll;
      if (row.earliestJoinedAt < existing.earliestJoinedAt) {
        existing.earliestJoinedAt = row.earliestJoinedAt;
      }
    } else {
      map.set(key, { ...row, targets: [...row.targets] });
    }
  }
  for (const row of map.values()) {
    row.targets.sort((a, b) => a.label.localeCompare(b.label));
  }
  return [...map.values()].sort((a, b) =>
    a.principal.username.localeCompare(b.principal.username),
  );
}

export default function CollaboratorsPage({
  loaderData,
}: {
  loaderData: CollaboratorsPageData;
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
          role: u.role,
          targets: [
            {
              id: s.org.id,
              label: s.org.slug,
              link: `/orgs/${s.org.slug}`,
              canEdit: s.myRole === "owner",
              joined_at: u.joined_at,
            },
          ],
          canEditAll: s.myRole === "owner",
          earliestJoinedAt: u.joined_at,
        })),
      );
    return groupRows(flat);
  }, [loaderData.orgSections, scope]);

  const docoRows = useMemo(() => {
    const flat: GroupedRow[] = loaderData.docoSections
      .filter((s) => scope === "all" || scope === `doco:${s.doco.id}`)
      .flatMap((s) =>
        s.users.map<GroupedRow>((u) => ({
          level: "doco",
          principal: u,
          role: u.role,
          targets: [
            {
              id: s.doco.id,
              label: s.doco.handle,
              link: `/${s.doco.handle}`,
              canEdit: s.myRole === "owner",
              joined_at: u.joined_at,
            },
          ],
          canEditAll: s.myRole === "owner",
          earliestJoinedAt: u.joined_at,
        })),
      );
    return groupRows(flat);
  }, [loaderData.docoSections, scope]);

  // When scope filters to a specific org, hide the doco section entirely
  // (and vice-versa) so the page doesn't show "no docos match" noise.
  const showOrgSection = scope === "all" || scope.startsWith("org:");
  const showDocoSection = scope === "all" || scope.startsWith("doco:");

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Collaborators" })} />
        <header>
          <h1 className="text-2xl font-semibold">Collaborators</h1>
        </header>

        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Show collaborators for
            </span>
            <select
              value={scope}
              onChange={(e) => applyScope(e.currentTarget.value)}
              data-testid="scope-filter"
              className="w-full rounded-md border border-border bg-background px-3 py-2 sm:max-w-sm"
            >
              <option value="all">All collaborators</option>
              {loaderData.orgSections.length > 0 ? (
                <optgroup label="By org">
                  {loaderData.orgSections.map((s) => (
                    <option key={s.org.id} value={`org:${s.org.id}`}>
                      {s.org.slug}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {loaderData.docoSections.length > 0 ? (
                <optgroup label="By doco">
                  {loaderData.docoSections.map((s) => (
                    <option key={s.doco.id} value={`doco:${s.doco.id}`}>
                      {s.doco.handle}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>

          <div className="flex justify-end">
            <Link
              to="/collaborators/invite"
              data-testid="invite-toggle"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              + Invite collaborator (people/agents)
            </Link>
          </div>
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
            empty="You don't have any doco grants yet."
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
  const people = rows
    .filter((r) => r.principal.kind === "person")
    .sort((a, b) => {
      const am = a.principal.principal_id === myPrincipalId;
      const bm = b.principal.principal_id === myPrincipalId;
      if (am !== bm) return am ? -1 : 1;
      return a.principal.username.localeCompare(b.principal.username);
    });
  const agents = rows.filter((r) => r.principal.kind === "agent");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="border-t border-border pt-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[24%]" />
                <col className="w-[14%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">User</th>
                  <th className="pb-2 font-medium">Access to</th>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 font-medium">Last activity</th>
                  <th className="pb-2 font-medium">Granted</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <GroupBody
                label="People"
                rows={people}
                empty="No people yet."
                myPrincipalId={myPrincipalId}
              />
              <GroupBody
                label="Agents"
                rows={agents}
                empty="No agents yet."
                myPrincipalId={myPrincipalId}
                topBorder
              />
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GroupBody({
  label,
  rows,
  empty,
  myPrincipalId,
  topBorder,
}: {
  label: string;
  rows: GroupedRow[];
  empty: string;
  myPrincipalId: string;
  topBorder?: boolean;
}) {
  return (
    <tbody className={topBorder ? "border-t border-border" : undefined}>
      <tr>
        <td colSpan={6} className="pt-4 pb-2 text-sm font-semibold">
          {label}
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={6} className="py-2 text-sm text-muted-foreground">
            {empty}
          </td>
        </tr>
      ) : (
        rows.map((r) => (
          <UserRow
            key={`${r.level}-${r.principal.principal_id}-${r.role}`}
            row={r}
            myPrincipalId={myPrincipalId}
          />
        ))
      )}
    </tbody>
  );
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

function parseAgentName(full: string): { primary: string; caption: string | null } {
  const m = full.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (!m) return { primary: full, caption: null };
  const primary = m[1].trim();
  const inside = m[2].trim();
  const first = inside.split(/,\s*/)[0]?.trim() ?? "";
  return { primary, caption: first || null };
}

const MAX_VISIBLE_TARGETS = 2;

function UserRow({
  row,
  myPrincipalId,
}: {
  row: GroupedRow;
  myPrincipalId: string;
}) {
  const roleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();

  const targetIdsCsv = row.targets.map((t) => t.id).join(",");
  const isOauth = row.principal.source === "oauth";
  const clientId = row.principal.client_id ?? "";
  const updateIntent = isOauth ? "oauth_update" : "update";
  const removeIntent = isOauth ? "oauth_remove" : "remove";

  const matchesThisRow = (data: ActionResult) => {
    if (!("intent" in data)) return false;
    if (data.target_ids.join(",") !== targetIdsCsv) return false;
    if (isOauth) {
      return (
        (data.intent === "oauth_update" || data.intent === "oauth_remove") &&
        data.client_id === clientId
      );
    }
    return (
      (data.intent === "update" || data.intent === "remove") &&
      data.principal_id === row.principal.principal_id
    );
  };

  const justSaved =
    roleFetcher.state === "idle" &&
    roleFetcher.data &&
    "intent" in roleFetcher.data &&
    (roleFetcher.data.intent === "update" || roleFetcher.data.intent === "oauth_update") &&
    matchesThisRow(roleFetcher.data);
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

  const username = row.principal.username;
  const removeLabel =
    row.targets.length === 1
      ? `Remove ${username} from ${row.targets[0].label}?`
      : `Remove ${username} from ${row.targets.length} places (${row.targets
          .map((t) => t.label)
          .join(", ")})?`;

  const updatePayload = (newRole: string): Record<string, string> => {
    const base: Record<string, string> = {
      intent: updateIntent,
      level: row.level,
      target_ids: targetIdsCsv,
      role: newRole,
    };
    if (isOauth) base.client_id = clientId;
    else base.principal_id = row.principal.principal_id;
    return base;
  };

  const removePayload: Record<string, string> = (() => {
    const base: Record<string, string> = {
      intent: removeIntent,
      level: row.level,
      target_ids: targetIdsCsv,
    };
    if (isOauth) base.client_id = clientId;
    else base.principal_id = row.principal.principal_id;
    return base;
  })();

  const parsed = isOauth ? parseAgentName(username) : null;
  const primaryName = parsed?.primary ?? username;
  const caption = parsed?.caption ?? null;
  const isMe = !isOauth && row.principal.principal_id === myPrincipalId;

  const visibleTargets = row.targets.slice(0, MAX_VISIBLE_TARGETS);
  const overflowTargets = row.targets.slice(MAX_VISIBLE_TARGETS);

  return (
    <tr data-testid={`row-${row.level}-${username}-${row.role}`}>
      <td className="py-2 pr-3 align-middle">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium" title={username}>
            {primaryName}
          </span>
          {isOauth ? (
            <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              agent
            </span>
          ) : null}
          {isMe ? (
            <span className="shrink-0 rounded border border-border bg-input px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              you
            </span>
          ) : null}
        </div>
        {caption ? (
          <div className="truncate text-xs text-muted-foreground" title={username}>
            {caption}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-3 align-middle">
        <div className="flex flex-wrap items-center gap-1">
          {visibleTargets.map((t) => (
            <Link
              key={t.id}
              to={t.link}
              className="inline-flex max-w-[12rem] items-center truncate rounded-full border border-border bg-input px-2 py-0.5 text-xs hover:bg-card"
              title={`${t.label} — granted ${formatDate(t.joined_at)}`}
            >
              {t.label}
            </Link>
          ))}
          {overflowTargets.length > 0 ? (
            <span
              className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              title={overflowTargets.map((t) => t.label).join(", ")}
            >
              +{overflowTargets.length} more
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-2 pr-3 align-middle">
        <div className="inline-flex items-center gap-2">
          <select
            defaultValue={row.role}
            disabled={!row.canEditAll || roleFetcher.state !== "idle"}
            data-testid={`role-${row.level}-${username}-${row.role}`}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"
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
          <span
            className="truncate text-xs text-muted-foreground"
            data-testid={`status-${row.level}-${username}-${row.role}`}
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
      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
        {formatRelative(row.principal.last_activity_at)}
      </td>
      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
        {formatDate(row.earliestJoinedAt)}
      </td>
      <td className="py-2 align-middle text-right">
        {row.canEditAll ? (
          <button
            type="button"
            disabled={removeFetcher.state !== "idle"}
            data-testid={`remove-${row.level}-${username}-${row.role}`}
            onClick={() => {
              if (!confirm(removeLabel)) return;
              removeFetcher.submit(removePayload, { method: "post" });
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
