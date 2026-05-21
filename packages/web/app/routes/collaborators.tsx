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
  type UserCell,
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
  if (!me) return { error: "Sign in to manage collaborators." };

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
      if (role !== "owner") return { error: "Only org owners can change org collaborators." };
    } else if (level === "doco") {
      const doco = await getDocoById(targetId);
      if (!doco) return { error: "Doco not found." };
      const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, me.id);
      if (role !== "owner") return { error: "Only doco owners can change doco collaborators." };
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

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Collaborators · Doco" }];
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
    // Drop the legacy level/target_id once the user picks a new scope so
    // the URL stays clean.
    next.delete("level");
    next.delete("target_id");
    setSearchParams(next, { replace: true });
  }

  const filteredOrgRows = useMemo(
    () =>
      loaderData.orgSections
        .filter((s) => scope === "all" || scope === `org:${s.org.id}`)
        .flatMap((s) =>
          s.users.map((u) => ({
            level: "org" as const,
            target_id: s.org.id,
            target_label: s.org.slug,
            target_link: `/orgs/${s.org.slug}`,
            user: u,
            canEdit: s.myRole === "owner",
          })),
        ),
    [loaderData.orgSections, scope],
  );

  const filteredDocoRows = useMemo(
    () =>
      loaderData.docoSections
        .filter((s) => scope === "all" || scope === `doco:${s.doco.id}`)
        .flatMap((s) =>
          s.users.map((u) => ({
            level: "doco" as const,
            target_id: s.doco.id,
            target_label: s.doco.handle,
            target_link: `/${s.doco.handle}`,
            user: u,
            canEdit: s.myRole === "owner",
          })),
        ),
    [loaderData.docoSections, scope],
  );

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
            title="Org collaborators"
            empty="You don't have any org grants yet."
            rows={filteredOrgRows}
          />
        ) : null}

        {showDocoSection ? (
          <Section
            title="Doco collaborators"
            empty="You don't have any doco grants yet."
            rows={filteredDocoRows}
          />
        ) : null}
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
