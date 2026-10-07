import type { DocoRole } from "@doco/db";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Form, redirect } from "react-router";
import { hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { type ScopeOption, loadScopeOptions } from "~/lib/api-keys.server";
import { canSetChannelDefaultAccess } from "~/lib/group-chat-ux";
import { getCurrentPrincipal } from "~/lib/session.server";
import {
  type SlackInstallationSummary,
  listSlackInstallations,
  replaceSlackChannelConnections,
} from "~/lib/slack.server";
import { rankOf } from "~/lib/user-invite";

interface SlackSetupPageData {
  installation: SlackInstallationSummary;
  workspaceGroups: WorkspacePermissionGroup[];
}

interface WorkspacePermissionGroup {
  key: string;
  handle: string;
  workspaceOption: ScopeOption | null;
  docos: DocoPermissionOption[];
}

interface DocoPermissionOption {
  id: string;
  label: string;
  myRole: DocoRole;
}

interface DraftWorkspaceState {
  selected: boolean;
  mode: "all" | "specific";
  workspaceRole: DocoRole;
  docoRoles: Record<string, DocoRole | "none">;
}

interface SlackGrantInput {
  targetLevel: "workspace" | "doco";
  targetId: string;
  role: DocoRole;
}

const WORKSPACE_DEFAULT_CHANNEL_ID = "*";
const WORKSPACE_DEFAULT_CHANNEL_NAME = "workspace";
const DEFAULT_ROLES: DocoRole[] = ["reader", "writer"];
const ROLE_SELECT_CLASS = "rounded-md px-3 py-2 text-sm font-semibold";

export async function loader({ request }: { request: Request }): Promise<SlackSetupPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }

  const installations = await listSlackInstallations();
  if (installations.length === 0) {
    throw redirect("/integrations?slack_not_installed=1");
  }

  const requestedTeamId = url.searchParams.get("team_id")?.trim();
  const installation =
    installations.find((item) => item.workspaceId === requestedTeamId) ?? installations[0];
  // The team is bound to one Doco workspace at install. Setup configures the
  // DEFAULT access within that workspace — it never re-picks the workspace.
  if (!installation.docoWorkspaceId) {
    throw redirect("/integrations/slack/install");
  }
  const workspaceGroups = buildWorkspacePermissionGroups(
    scopedToWorkspace(await loadScopeOptions(me.id), installation.docoWorkspaceId),
  );

  return {
    installation,
    workspaceGroups,
  };
}

/** Scope-options limited to one Doco workspace (the workspace itself + its
 * Docos) — setup only ever configures defaults inside the team's bound one. */
function scopedToWorkspace(options: ScopeOption[], workspaceId: string): ScopeOption[] {
  return options.filter(
    (o) =>
      (o.level === "workspace" && o.id === workspaceId) ||
      (o.level === "doco" && o.workspaceId === workspaceId),
  );
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }

  const form = await request.formData();
  const workspaceId = String(form.get("workspace_id") ?? "").trim();
  if (!workspaceId) {
    return Response.json({ error: "missing_slack_workspace" }, { status: 400 });
  }

  const installations = await listSlackInstallations();
  const installation = installations.find((item) => item.workspaceId === workspaceId);
  if (!installation) {
    return Response.json({ error: "slack_workspace_not_installed" }, { status: 403 });
  }
  // The bound workspace is fixed at install; setup only sets defaults within
  // it. Scoping the options here confines every grant to that one workspace.
  if (!installation.docoWorkspaceId) {
    return Response.json({ error: "slack_workspace_not_bound" }, { status: 409 });
  }
  const scopeOptions = scopedToWorkspace(
    await loadScopeOptions(me.id),
    installation.docoWorkspaceId,
  );
  const workspaceGroups = buildWorkspacePermissionGroups(scopeOptions);
  const grants = collectGrantsFromForm(form, workspaceGroups);
  if (grants.length === 0) {
    return Response.json({ error: "pick_at_least_one_default_permission" }, { status: 400 });
  }

  const validationError = validateGrants(grants, scopeOptions);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 403 });
  }

  await replaceSlackChannelConnections({
    workspaceId,
    channelId: WORKSPACE_DEFAULT_CHANNEL_ID,
    channelName: WORKSPACE_DEFAULT_CHANNEL_NAME,
    grants,
    createdByUserId: me.id,
  });

  throw redirect(
    `/integrations?slack_connected=${encodeURIComponent(installation.workspaceName || workspaceId)}`,
  );
}

export function meta() {
  return [{ title: "Set Up Slack · Doco" }];
}

export default function SlackSetupPage({ loaderData }: { loaderData: SlackSetupPageData }) {
  const { installation, workspaceGroups } = loaderData;
  const [workspaceState, setWorkspaceState] = useState<Record<string, DraftWorkspaceState>>(() =>
    Object.fromEntries(workspaceGroups.map((group) => [group.key, initialWorkspaceState(group)])),
  );

  function updateWorkspace(key: string, patch: Partial<DraftWorkspaceState>) {
    setWorkspaceState((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch,
      },
    }));
  }

  function updateDocoRole(key: string, docoId: string, role: DocoRole | "none") {
    setWorkspaceState((current) => ({
      ...current,
      [key]: {
        ...current[key],
        docoRoles: {
          ...current[key]?.docoRoles,
          [docoId]: role,
        },
      },
    }));
  }

  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={[
          ...hostBreadcrumb({ pageLabel: "App integrations" }),
          { label: "Slack setup" },
        ]}
        title="Set up Slack"
      >
        <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
          This Slack team is connected to one doco workspace (chosen when it was installed) — set
          Señor Doco's default access there below. It can never use a person's access in any other
          workspace. People can still link their own doco account; their personal access is likewise
          capped to this workspace and never exceeds the role they already hold.
        </p>
      </PageHeader>

      <Form method="post" className="max-w-3xl">
        <input type="hidden" name="workspace_id" value={installation.workspaceId} />

        <Card>
          <CardHeader>
            <CardTitle>Default access</CardTitle>
            <CardDescription>
              Slack workspace: {installation.workspaceName}. Set what Señor Doco can do by default
              for everyone in this Slack team — limited to the
              {workspaceGroups[0] ? ` ${workspaceGroups[0].handle}` : ""} doco workspace this team
              is connected to.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {workspaceGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You don't have access to the doco workspace this Slack team is connected to, so you
                can't set its defaults. Ask one of its owners.
              </p>
            ) : null}

            {workspaceGroups.map((group) => {
              const state = workspaceState[group.key] ?? initialWorkspaceState(group);
              const allWorkspaceAvailable = Boolean(group.workspaceOption);
              return (
                <section key={group.key} className="neu-surface rounded-md bg-background p-4">
                  {/* The workspace is fixed (chosen at install); not a choice here. */}
                  <input type="hidden" name="workspace_key" value={group.key} />
                  <div className="text-sm font-semibold text-foreground">
                    <span className="block">{group.handle} workspace</span>
                    <span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">
                      {group.docos.length} accessible {group.docos.length === 1 ? "doco" : "docos"}
                    </span>
                  </div>

                  {state.selected ? (
                    <div className="mt-4 space-y-4 border-t border-border pt-4">
                      <div className="grid gap-2 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`workspace_mode:${group.key}`}
                            value="all"
                            checked={state.mode === "all"}
                            disabled={!allWorkspaceAvailable}
                            onChange={() => updateWorkspace(group.key, { mode: "all" })}
                          />
                          All docos in {group.handle}
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`workspace_mode:${group.key}`}
                            value="specific"
                            checked={state.mode === "specific"}
                            onChange={() => updateWorkspace(group.key, { mode: "specific" })}
                          />
                          Specific docos
                        </label>
                      </div>

                      {state.mode === "all" && allWorkspaceAvailable ? (
                        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          What should be Señor Doco's default level of access for all docos in this
                          workspace?
                          <select
                            name={`workspace_role:${group.key}`}
                            value={state.workspaceRole}
                            onChange={(event) =>
                              updateWorkspace(group.key, {
                                workspaceRole: event.target.value as DocoRole,
                              })
                            }
                            className={ROLE_SELECT_CLASS}
                          >
                            {rolesFor(group.workspaceOption?.myRole).map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(role)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}

                      {state.mode === "all" && !allWorkspaceAvailable ? (
                        <p className="text-sm text-muted-foreground">
                          You can set defaults for specific docos in {group.handle}, but you do not
                          have workspace-wide access to grant every doco in this workspace.
                        </p>
                      ) : null}

                      {state.mode === "specific" ? (
                        <div className="space-y-2">
                          {group.docos.map((doco) => (
                            <label
                              key={doco.id}
                              className="neu-well grid gap-2 rounded-md p-3 text-sm md:grid-cols-[minmax(0,1fr)_180px] md:items-center"
                            >
                              <span className="min-w-0 font-semibold text-foreground">
                                {doco.label}
                              </span>
                              <select
                                name={`doco_role:${doco.id}`}
                                value={state.docoRoles[doco.id] ?? "none"}
                                onChange={(event) =>
                                  updateDocoRole(
                                    group.key,
                                    doco.id,
                                    event.target.value as DocoRole | "none",
                                  )
                                }
                                className={ROLE_SELECT_CLASS}
                              >
                                <option value="none">No access</option>
                                {rolesFor(doco.myRole).map((role) => (
                                  <option key={role} value={role}>
                                    {roleLabel(role)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}

            <button
              type="submit"
              disabled={workspaceGroups.length === 0}
              className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Save default permissions
            </button>
          </CardContent>
        </Card>
      </Form>
    </PageMain>
  );
}

function buildWorkspacePermissionGroups(options: ScopeOption[]): WorkspacePermissionGroup[] {
  const groups = new Map<string, WorkspacePermissionGroup>();
  for (const option of options) {
    if (option.level === "workspace") {
      groups.set(option.label, {
        key: option.label,
        handle: option.label,
        workspaceOption: option,
        docos: groups.get(option.label)?.docos ?? [],
      });
    }
  }

  for (const option of options) {
    if (option.level !== "doco") continue;
    const { workspaceHandle } = splitDocoLabel(option.label);
    const key = workspaceHandle || option.label;
    const existing = groups.get(key);
    groups.set(key, {
      key,
      handle: workspaceHandle || key,
      workspaceOption: existing?.workspaceOption ?? null,
      docos: [
        ...(existing?.docos ?? []),
        {
          id: option.id,
          label: option.label,
          myRole: option.myRole,
        },
      ],
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      docos: [...group.docos].sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

function initialWorkspaceState(group: WorkspacePermissionGroup): DraftWorkspaceState {
  return {
    // The bound workspace is fixed at install; its default-access controls are
    // always shown (there is no workspace to select here).
    selected: true,
    mode: group.workspaceOption ? "all" : "specific",
    workspaceRole: "reader",
    docoRoles: Object.fromEntries(group.docos.map((doco) => [doco.id, "none"])),
  };
}

function collectGrantsFromForm(
  form: FormData,
  groups: WorkspacePermissionGroup[],
): SlackGrantInput[] {
  const selectedWorkspaceKeys = new Set(form.getAll("workspace_key").map((value) => String(value)));
  const grants: SlackGrantInput[] = [];

  for (const group of groups) {
    if (!selectedWorkspaceKeys.has(group.key)) continue;
    const mode = form.get(`workspace_mode:${group.key}`) === "specific" ? "specific" : "all";
    if (mode === "all" && group.workspaceOption) {
      const roleField = `workspace_role:${group.key}`;
      const role = form.has(roleField) ? parseDefaultRole(form.get(roleField)) : "reader";
      if (!role) continue;
      grants.push({ targetLevel: "workspace", targetId: group.workspaceOption.id, role });
      continue;
    }

    for (const doco of group.docos) {
      const role = parseDefaultRole(form.get(`doco_role:${doco.id}`));
      if (!role) continue;
      grants.push({ targetLevel: "doco", targetId: doco.id, role });
    }
  }

  return grants;
}

function validateGrants(grants: SlackGrantInput[], options: ScopeOption[]): string | null {
  for (const grant of grants) {
    const option = options.find(
      (scope) => scope.level === grant.targetLevel && scope.id === grant.targetId,
    );
    if (!option) return "target_not_available";
    const capability = canSetChannelDefaultAccess({
      personalRole: option.myRole,
      requestedRole: grant.role,
    });
    if (!capability.ok) return capability.error ?? "role_not_allowed";
  }
  return null;
}

function rolesFor(personalRole: DocoRole | undefined): DocoRole[] {
  if (!personalRole) return [];
  return DEFAULT_ROLES.filter((role) => rankOf(role) <= rankOf(personalRole));
}

function parseDefaultRole(value: FormDataEntryValue | null): DocoRole | null {
  const role = String(value ?? "");
  return DEFAULT_ROLES.includes(role as DocoRole) ? (role as DocoRole) : null;
}

function roleLabel(role: DocoRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function splitDocoLabel(label: string): { workspaceHandle: string; docoHandle: string } {
  const slash = label.indexOf("/");
  if (slash < 0) return { workspaceHandle: "", docoHandle: label };
  return {
    workspaceHandle: label.slice(0, slash),
    docoHandle: label.slice(slash + 1),
  };
}
