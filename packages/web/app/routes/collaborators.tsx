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
  type PrincipalKind,
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
          />
        ) : null}

        {showDocoSection ? (
          <Section
            title="Per-doco collaborators"
            empty="You don't have any doco grants yet."
            rows={docoRows}
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
}: {
  title: string;
  empty: string;
  rows: GroupedRow[];
}) {
  const people = rows.filter((r) => r.principal.kind === "person");
  const agents = rows.filter((r) => r.principal.kind === "agent");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="space-y-6">
            <Subsection kind="person" rows={people} empty="No people yet." />
            <Subsection kind="agent" rows={agents} empty="No agents yet." />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Subsection({
  kind,
  rows,
  empty,
}: {
  kind: PrincipalKind;
  rows: GroupedRow[];
  empty: string;
}) {
  const heading = kind === "person" ? "People" : "Agents";
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{heading}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
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
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <UserRow
                  key={`${r.level}-${r.principal.principal_id}-${r.role}`}
                  row={r}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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

function UserRow({ row }: { row: GroupedRow }) {
  const roleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();

  const targetIdsCsv = row.targets.map((t) => t.id).join(",");

  const justSaved =
    roleFetcher.state === "idle" &&
    roleFetcher.data &&
    "intent" in roleFetcher.data &&
    roleFetcher.data.intent === "update" &&
    roleFetcher.data.principal_id === row.principal.principal_id &&
    roleFetcher.data.target_ids.join(",") === targetIdsCsv;
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
  const isOauth = row.principal.source === "oauth";
  const removeLabel =
    row.targets.length === 1
      ? `Remove ${username} from ${row.targets[0].label}?`
      : `Remove ${username} from ${row.targets.length} places (${row.targets
          .map((t) => t.label)
          .join(", ")})?`;

  return (
    <tr data-testid={`row-${row.level}-${username}-${row.role}`}>
      <td className="py-2 align-middle">
        <div className="font-medium">{username}</div>
        {isOauth ? (
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            OAuth client
          </div>
        ) : null}
      </td>
      <td className="py-2 align-middle">
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {row.targets.map((t) => (
            <Link
              key={t.id}
              to={t.link}
              className="text-xs underline"
              title={`Granted ${formatDate(t.joined_at)}`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </td>
      <td className="py-2 align-middle">
        {isOauth ? (
          <span className="text-sm">{row.role}</span>
        ) : (
          <div className="inline-flex items-center gap-2">
            <select
              defaultValue={row.role}
              disabled={!row.canEditAll || roleFetcher.state !== "idle"}
              data-testid={`role-${row.level}-${username}-${row.role}`}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"
              onChange={(e) => {
                roleFetcher.submit(
                  {
                    intent: "update",
                    level: row.level,
                    target_ids: targetIdsCsv,
                    principal_id: row.principal.principal_id,
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
        )}
      </td>
      <td className="py-2 align-middle text-xs text-muted-foreground">
        {formatRelative(row.principal.last_activity_at)}
      </td>
      <td className="py-2 align-middle text-xs text-muted-foreground">
        {formatDate(row.earliestJoinedAt)}
      </td>
      <td className="py-2 align-middle text-right">
        {isOauth ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : row.canEditAll ? (
          <button
            type="button"
            disabled={removeFetcher.state !== "idle"}
            data-testid={`remove-${row.level}-${username}-${row.role}`}
            onClick={() => {
              if (!confirm(removeLabel)) return;
              removeFetcher.submit(
                {
                  intent: "remove",
                  level: row.level,
                  target_ids: targetIdsCsv,
                  principal_id: row.principal.principal_id,
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
