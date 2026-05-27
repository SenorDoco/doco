import type { DocoRole } from "@doco/db";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Form, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { type ScopeOption, loadScopeOptions } from "~/lib/api-keys.server";
import { rankOf } from "~/lib/collaborator-invite";
import { canSetChannelDefaultAccess } from "~/lib/group-chat-ux";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import {
  type SlackInstallationSummary,
  listSlackInstallations,
  replaceSlackChannelConnections,
} from "~/lib/slack.server";

interface SlackSetupPageData {
  me: CurrentPrincipal;
  installation: SlackInstallationSummary;
  orgGroups: OrgPermissionGroup[];
}

interface OrgPermissionGroup {
  key: string;
  handle: string;
  orgOption: ScopeOption | null;
  docos: DocoPermissionOption[];
}

interface DocoPermissionOption {
  id: string;
  label: string;
  myRole: DocoRole;
}

interface DraftOrgState {
  selected: boolean;
  mode: "all" | "specific";
  orgRole: DocoRole;
  docoRoles: Record<string, DocoRole | "none">;
}

interface SlackGrantInput {
  targetLevel: "org" | "doco";
  targetId: string;
  role: DocoRole;
}

const WORKSPACE_DEFAULT_CHANNEL_ID = "*";
const WORKSPACE_DEFAULT_CHANNEL_NAME = "workspace";
const DEFAULT_ROLES: DocoRole[] = ["reader", "author", "approver"];
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
  const orgGroups = buildOrgPermissionGroups(await loadScopeOptions(me.id));

  return {
    me,
    installation,
    orgGroups,
  };
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

  const scopeOptions = await loadScopeOptions(me.id);
  const orgGroups = buildOrgPermissionGroups(scopeOptions);
  const grants = collectGrantsFromForm(form, orgGroups);
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
    createdByCollaboratorId: me.id,
  });

  throw redirect(
    `/integrations?slack_connected=${encodeURIComponent(installation.workspaceName || workspaceId)}`,
  );
}

export function meta() {
  return [{ title: "Set Up Slack · Doco" }];
}

export default function SlackSetupPage({ loaderData }: { loaderData: SlackSetupPageData }) {
  const { me, installation, orgGroups } = loaderData;
  const [orgState, setOrgState] = useState<Record<string, DraftOrgState>>(() =>
    Object.fromEntries(orgGroups.map((group) => [group.key, initialOrgState(group)])),
  );

  function updateOrg(key: string, patch: Partial<DraftOrgState>) {
    setOrgState((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch,
      },
    }));
  }

  function updateDocoRole(key: string, docoId: string, role: DocoRole | "none") {
    setOrgState((current) => ({
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
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb
          items={[...hostBreadcrumb({ pageLabel: "Integrations" }), { label: "Slack setup" }]}
        />
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold">Set up Slack</h1>
          <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
            Set the default permissions for Señor Doco. It applies to everyone in this Slack
            workspace. People can still link their own Doco account. If they already have higher
            access in Doco, Señor Doco may use that higher personal access for their requests, but
            never more than the access they already hold.
          </p>
        </header>

        <Form method="post" className="max-w-3xl">
          <input type="hidden" name="workspace_id" value={installation.workspaceId} />

          <Card>
            <CardHeader>
              <CardTitle>Organizations</CardTitle>
              <CardDescription>
                Slack workspace: {installation.workspaceName}. Choose which organizations Señor Doco
                can use by default.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {orgGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  You do not have access to any organization or Doco that can be shared with Slack.
                </p>
              ) : null}

              {orgGroups.map((group) => {
                const state = orgState[group.key] ?? initialOrgState(group);
                const allOrgAvailable = Boolean(group.orgOption);
                return (
                  <section
                    key={group.key}
                    className="rounded-md border border-border bg-background p-4"
                  >
                    <label className="flex items-start gap-3 text-sm font-semibold text-foreground">
                      <input
                        type="checkbox"
                        name="org_key"
                        value={group.key}
                        checked={state.selected}
                        onChange={(event) =>
                          updateOrg(group.key, { selected: event.target.checked })
                        }
                        className="mt-1 h-4 w-4"
                      />
                      <span>
                        <span className="block">{group.handle}</span>
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">
                          {group.docos.length} accessible{" "}
                          {group.docos.length === 1 ? "Doco" : "Docos"}
                        </span>
                      </span>
                    </label>

                    {state.selected ? (
                      <div className="mt-4 space-y-4 border-t border-border pt-4">
                        <div className="grid gap-2 text-sm">
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`org_mode:${group.key}`}
                              value="all"
                              checked={state.mode === "all"}
                              disabled={!allOrgAvailable}
                              onChange={() => updateOrg(group.key, { mode: "all" })}
                            />
                            All Docos in {group.handle}
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`org_mode:${group.key}`}
                              value="specific"
                              checked={state.mode === "specific"}
                              onChange={() => updateOrg(group.key, { mode: "specific" })}
                            />
                            Specific Docos
                          </label>
                        </div>

                        {state.mode === "all" && allOrgAvailable ? (
                          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            What should be Señor Doco's default level of access for all Docos in
                            this organization?
                            <select
                              name={`org_role:${group.key}`}
                              value={state.orgRole}
                              onChange={(event) =>
                                updateOrg(group.key, { orgRole: event.target.value as DocoRole })
                              }
                              className={ROLE_SELECT_CLASS}
                            >
                              {rolesFor(group.orgOption?.myRole).map((role) => (
                                <option key={role} value={role}>
                                  {roleLabel(role)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {state.mode === "all" && !allOrgAvailable ? (
                          <p className="text-sm text-muted-foreground">
                            You can set defaults for specific Docos in {group.handle}, but you do
                            not have organization-wide access to grant every Doco in this
                            organization.
                          </p>
                        ) : null}

                        {state.mode === "specific" ? (
                          <div className="space-y-2">
                            {group.docos.map((doco) => (
                              <label
                                key={doco.id}
                                className="grid gap-2 rounded-md border border-border p-3 text-sm md:grid-cols-[minmax(0,1fr)_180px] md:items-center"
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
                disabled={orgGroups.length === 0}
                className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Save default permissions
              </button>
            </CardContent>
          </Card>
        </Form>
      </SingleColumnPageMain>
    </div>
  );
}

function buildOrgPermissionGroups(options: ScopeOption[]): OrgPermissionGroup[] {
  const groups = new Map<string, OrgPermissionGroup>();
  for (const option of options) {
    if (option.level === "org") {
      groups.set(option.label, {
        key: option.label,
        handle: option.label,
        orgOption: option,
        docos: groups.get(option.label)?.docos ?? [],
      });
    }
  }

  for (const option of options) {
    if (option.level !== "doco") continue;
    const { orgHandle } = splitDocoLabel(option.label);
    const key = orgHandle || option.label;
    const existing = groups.get(key);
    groups.set(key, {
      key,
      handle: orgHandle || key,
      orgOption: existing?.orgOption ?? null,
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

function initialOrgState(group: OrgPermissionGroup): DraftOrgState {
  return {
    selected: false,
    mode: group.orgOption ? "all" : "specific",
    orgRole: "reader",
    docoRoles: Object.fromEntries(group.docos.map((doco) => [doco.id, "none"])),
  };
}

function collectGrantsFromForm(form: FormData, groups: OrgPermissionGroup[]): SlackGrantInput[] {
  const selectedOrgKeys = new Set(form.getAll("org_key").map((value) => String(value)));
  const grants: SlackGrantInput[] = [];

  for (const group of groups) {
    if (!selectedOrgKeys.has(group.key)) continue;
    const mode = form.get(`org_mode:${group.key}`) === "specific" ? "specific" : "all";
    if (mode === "all" && group.orgOption) {
      const roleField = `org_role:${group.key}`;
      const role = form.has(roleField) ? parseDefaultRole(form.get(roleField)) : "reader";
      if (!role) continue;
      grants.push({ targetLevel: "org", targetId: group.orgOption.id, role });
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

function splitDocoLabel(label: string): { orgHandle: string; docoHandle: string } {
  const slash = label.indexOf("/");
  if (slash < 0) return { orgHandle: "", docoHandle: label };
  return {
    orgHandle: label.slice(0, slash),
    docoHandle: label.slice(slash + 1),
  };
}
