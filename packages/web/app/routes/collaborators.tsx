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
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  return loadCollaboratorsPageData(request);
}

type ActionResult =
  | {
      intent: "update";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      collaborator_id: string;
      role: DocoRole;
    }
  | {
      intent: "remove";
      ok: true;
      level: InviteLevel;
      target_ids: string[];
      collaborator_id: string;
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
    const principalId = String(form.get("collaborator_id") ?? "").trim();
    if (targetIds.length === 0) return { error: "target_ids missing." };
    if (!principalId) return { error: "collaborator_id missing." };

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
          await upsertOrgUser({ org_id: targetId, collaborator_id: principalId, role });
        else await upsertDocoUser({ doco_id: targetId, collaborator_id: principalId, role });
      }
      return { intent: "update", ok: true, level, target_ids: targetIds, collaborator_id: principalId, role };
    }
    for (const targetId of targetIds) {
      if (level === "org") await removeOrgUser(targetId, principalId);
      else await removeDocoUser(targetId, principalId);
    }
    return { intent: "remove", ok: true, level, target_ids: targetIds, collaborator_id: principalId };
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
              WHERE collaborator_id = $1 AND client_id = $2 AND revoked = false
                AND $3 = ANY(${idsCol})`,
            [me.id, clientId, targetId, role],
          );
          await c.query(
            `UPDATE oauth_refresh_tokens
                SET ${rolesCol} = jsonb_set(${rolesCol}, ARRAY[$3], to_jsonb($4::text), true)
              WHERE collaborator_id = $1 AND client_id = $2 AND revoked = false
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
            WHERE collaborator_id = $1 AND client_id = $2 AND revoked = false`,
          [me.id, clientId, targetId],
        );
        await c.query(
          `UPDATE oauth_refresh_tokens
              SET ${idsCol}   = array_remove(${idsCol}, $3),
                  ${rolesCol} = ${rolesCol} - $3
            WHERE collaborator_id = $1 AND client_id = $2 AND revoked = false`,
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
  return [{ title: "Collaborators (people/agents) · Doco" }];
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
    const key = row.principal.collaborator_id;
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
          grants: [
            {
              target_id: s.org.id,
              target_label: s.org.slug,
              target_link: `/orgs/${s.org.slug}`,
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
      .filter((s) => scope === "all" || scope === `doco:${s.doco.id}`)
      .flatMap((s) =>
        s.users.map<GroupedRow>((u) => ({
          level: "doco",
          principal: u,
          grants: [
            {
              target_id: s.doco.id,
              target_label: s.doco.handle,
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
          <h1 className="text-2xl font-semibold">Collaborators (people/agents)</h1>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Show collaborators for
            </span>
            <select
              value={scope}
              onChange={(e) => applyScope(e.currentTarget.value)}
              data-testid="scope-filter"
              className="w-auto rounded-md border border-border bg-background px-3 py-2"
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

          <Link
            to="/collaborators/invite"
            data-testid="invite-toggle"
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            + Invite collaborator
          </Link>
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
                    key={`${r.level}-${r.principal.collaborator_id}`}
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
  const at = a.principal.last_activity_at ? Date.parse(a.principal.last_activity_at) : -Infinity;
  const bt = b.principal.last_activity_at ? Date.parse(b.principal.last_activity_at) : -Infinity;
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

function parseAgentName(full: string): { primary: string; caption: string | null } {
  const m = full.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (!m) return { primary: full, caption: null };
  const primary = m[1].trim();
  const inside = m[2].trim();
  const first = inside.split(/,\s*/)[0]?.trim() ?? "";
  return { primary, caption: first || null };
}

function UserRow({
  row,
  myPrincipalId,
}: {
  row: GroupedRow;
  myPrincipalId: string;
}) {
  const isOauth = row.principal.source === "oauth";
  const clientId = row.principal.client_id ?? "";
  const username = row.principal.username;
  const parsed = isOauth ? parseAgentName(username) : null;
  const primaryName = parsed?.primary ?? username;
  const caption = parsed?.caption ?? null;
  const isMe = !isOauth && row.principal.collaborator_id === myPrincipalId;

  const grantedAbs = formatDate(row.earliestJoinedAt);
  const grantedRel = formatRelative(row.earliestJoinedAt);
  const lastActive = formatRelative(row.principal.last_activity_at);
  const metaParts: string[] = [];
  if (caption) metaParts.push(caption);
  metaParts.push(`Granted ${grantedRel}`);
  metaParts.push(`Active ${lastActive}`);
  const metaTooltip = `Granted ${grantedAbs}${row.principal.last_activity_at ? ` · Last active ${row.principal.last_activity_at}` : ""}`;

  return (
    <tr data-testid={`row-${row.level}-${username}`}>
      <td className="py-3 pr-3 align-top">
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
        <div
          className="mt-0.5 truncate text-xs text-muted-foreground"
          title={metaTooltip}
        >
          {metaParts.join(" · ")}
        </div>
      </td>
      <td className="py-3 align-top">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Access to
        </div>
        <div className="mt-1 flex flex-col gap-1.5">
          {row.grants.map((g) => (
            <AccessLine
              key={g.target_id}
              level={row.level}
              isOauth={isOauth}
              principalId={row.principal.collaborator_id}
              clientId={clientId}
              username={username}
              grant={g}
            />
          ))}
        </div>
      </td>
    </tr>
  );
}

function AccessLine({
  level,
  isOauth,
  principalId,
  clientId,
  username,
  grant,
}: {
  level: InviteLevel;
  isOauth: boolean;
  principalId: string;
  clientId: string;
  username: string;
  grant: AccessGrant;
}) {
  const roleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();

  const updatePayload = (newRole: string): Record<string, string> => {
    const base: Record<string, string> = {
      intent: isOauth ? "oauth_update" : "update",
      level,
      target_ids: grant.target_id,
      role: newRole,
    };
    if (isOauth) base.client_id = clientId;
    else base.collaborator_id = principalId;
    return base;
  };
  const removePayload: Record<string, string> = (() => {
    const base: Record<string, string> = {
      intent: isOauth ? "oauth_remove" : "remove",
      level,
      target_ids: grant.target_id,
    };
    if (isOauth) base.client_id = clientId;
    else base.collaborator_id = principalId;
    return base;
  })();

  const error =
    roleFetcher.data && "error" in roleFetcher.data ? roleFetcher.data.error : undefined;
  const justSaved =
    roleFetcher.state === "idle" &&
    roleFetcher.data &&
    "intent" in roleFetcher.data &&
    (roleFetcher.data.intent === "update" || roleFetcher.data.intent === "oauth_update");
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (justSaved) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [justSaved]);

  return (
    <div className="flex items-center gap-1.5">
      <Link
        to={grant.target_link}
        className="inline-flex min-w-0 flex-1 items-center truncate rounded-full border border-border bg-input px-2 py-0.5 text-xs hover:bg-card"
        title={`${grant.target_label} — granted ${formatDate(grant.joined_at)}`}
      >
        {grant.target_label}
      </Link>
      <select
        defaultValue={grant.role}
        disabled={!grant.canEdit || roleFetcher.state !== "idle"}
        data-testid={`role-${level}-${username}-${grant.target_id}`}
        className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs disabled:opacity-50"
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
            if (!confirm(`Remove ${username} from ${grant.target_label}?`)) return;
            removeFetcher.submit(removePayload, { method: "post" });
          }}
          title={`Remove ${username} from ${grant.target_label}`}
          className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs text-destructive hover:bg-card disabled:opacity-50"
        >
          {removeFetcher.state !== "idle" ? "…" : "×"}
        </button>
      ) : null}
      {roleFetcher.state !== "idle" || error || showSaved ? (
        <span
          className="text-[10px] text-muted-foreground"
          aria-live="polite"
        >
          {roleFetcher.state !== "idle" ? "Saving…" : error ? <span className="text-destructive">{error}</span> : "Saved"}
        </span>
      ) : null}
    </div>
  );
}
