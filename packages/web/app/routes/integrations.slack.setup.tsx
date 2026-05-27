import type { DocoRole } from "@doco/db";
import { CheckCircle2, Hash, ShieldCheck } from "lucide-react";
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
  type SlackChannelOption,
  type SlackInstallationSummary,
  listSlackChannels,
  listSlackInstallations,
  saveSlackChannelConnection,
} from "~/lib/slack.server";

interface SlackSetupPageData {
  me: CurrentPrincipal;
  installation: SlackInstallationSummary;
  installations: SlackInstallationSummary[];
  channels: SlackChannelOption[];
  channelLoadError: string | null;
  targetOptions: SlackTargetOption[];
  initialChannelId: string;
  initialTargetValue: string;
}

interface SlackTargetOption extends ScopeOption {
  value: string;
  displayLabel: string;
  grantLabel: string;
}

interface SlackChannelContext {
  channelId: string;
  channelName: string;
}

const CHANNEL_DEFAULT_ROLES: DocoRole[] = ["reader", "author", "approver"];

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
  const channelContext = readSlackChannelContext(url);
  const { channels, channelLoadError } = await loadSlackChannelOptions(
    installation.workspaceId,
    channelContext,
  );
  const targetOptions = buildTargetOptions(await loadScopeOptions(me.id));

  return {
    me,
    installation,
    installations,
    channels,
    channelLoadError,
    targetOptions,
    initialChannelId: channelContext?.channelId ?? channels[0]?.id ?? "",
    initialTargetValue: targetOptions[0]?.value ?? "",
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
  const channelId = String(form.get("channel_id") ?? "").trim();
  const channelName = String(form.get("channel_name") ?? "").trim();
  const target = parseTargetValue(String(form.get("target") ?? ""));
  const role = String(form.get("role") ?? "") as DocoRole;

  if (!workspaceId || !channelId || !target) {
    return Response.json({ error: "missing_channel_or_target" }, { status: 400 });
  }
  const installations = await listSlackInstallations();
  if (!installations.some((installation) => installation.workspaceId === workspaceId)) {
    return Response.json({ error: "slack_workspace_not_installed" }, { status: 403 });
  }
  if (!CHANNEL_DEFAULT_ROLES.includes(role)) {
    return Response.json({ error: "invalid_channel_default_role" }, { status: 400 });
  }

  const scopeOptions = await loadScopeOptions(me.id);
  const scope = scopeOptions.find(
    (option) => option.level === target.level && option.id === target.id,
  );
  if (!scope) {
    return Response.json({ error: "target_not_available" }, { status: 403 });
  }

  const capability = canSetChannelDefaultAccess({
    personalRole: scope.myRole,
    requestedRole: role,
  });
  if (!capability.ok) {
    return Response.json({ error: capability.error ?? "role_not_allowed" }, { status: 403 });
  }

  await saveSlackChannelConnection({
    workspaceId,
    channelId,
    channelName,
    targetLevel: target.level,
    targetId: target.id,
    role,
    createdByCollaboratorId: me.id,
  });

  throw redirect(`/integrations?slack_connected=${encodeURIComponent(channelName || channelId)}`);
}

export function meta() {
  return [{ title: "Set Up Slack · Doco" }];
}

export default function SlackSetupPage({ loaderData }: { loaderData: SlackSetupPageData }) {
  const {
    me,
    installation,
    installations,
    channels,
    channelLoadError,
    targetOptions,
    initialChannelId,
    initialTargetValue,
  } = loaderData;
  const [selectedChannelId, setSelectedChannelId] = useState(initialChannelId);
  const [selectedTargetValue, setSelectedTargetValue] = useState(initialTargetValue);
  const selectedTarget = targetOptions.find((option) => option.value === selectedTargetValue);
  const allowedRoles = selectedTarget
    ? CHANNEL_DEFAULT_ROLES.filter((role) => rankOf(role) <= rankOf(selectedTarget.myRole))
    : [];
  const [selectedRole, setSelectedRole] = useState<DocoRole>("reader");
  const effectiveRole = allowedRoles.includes(selectedRole)
    ? selectedRole
    : (allowedRoles[0] ?? "reader");
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const channelLabel = selectedChannel
    ? `#${selectedChannel.name.replace(/^#/, "")}`
    : "a Slack channel";
  const canSubmit = Boolean(selectedChannel && selectedTarget && allowedRoles.length > 0);

  function selectTarget(value: string) {
    setSelectedTargetValue(value);
    setSelectedRole("reader");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb
          items={[...hostBreadcrumb({ pageLabel: "Integrations" }), { label: "Slack setup" }]}
        />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Set up Slack</h1>
          <p className="text-sm text-muted-foreground">
            Choose where Señor Doco should respond and what shared default Doco access that channel
            gets.
          </p>
        </header>

        <Form method="post" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <input type="hidden" name="workspace_id" value={installation.workspaceId} />
          <input type="hidden" name="channel_id" value={selectedChannel?.id ?? ""} />
          <input type="hidden" name="channel_name" value={selectedChannel?.name ?? ""} />

          <Card>
            <CardHeader>
              <CardTitle>Slack channel</CardTitle>
              <CardDescription>
                This channel will receive the shared Señor Doco default access.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Workspace
                  <select
                    value={installation.workspaceId}
                    onChange={(event) => {
                      const params = new URLSearchParams({ team_id: event.target.value });
                      window.location.href = `/integrations/slack/setup?${params.toString()}`;
                    }}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  >
                    {installations.map((item) => (
                      <option key={item.workspaceId} value={item.workspaceId}>
                        {item.workspaceName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Channel
                  <span className="relative">
                    <Hash
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <select
                      value={selectedChannelId}
                      disabled={channels.length === 0}
                      onChange={(event) => setSelectedChannelId(event.target.value)}
                      className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground disabled:opacity-60"
                    >
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.name}
                          {channel.isPrivate ? " (private)" : ""}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              </div>

              {channelLoadError ? (
                <p className="text-sm text-muted-foreground">{channelLoadError}</p>
              ) : null}

              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Doco access
                  <select
                    name="target"
                    value={selectedTargetValue}
                    disabled={targetOptions.length === 0}
                    onChange={(event) => selectTarget(event.target.value)}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
                  >
                    {targetOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.displayLabel}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Default role
                  <select
                    name="role"
                    value={effectiveRole}
                    disabled={allowedRoles.length === 0}
                    onChange={(event) => setSelectedRole(event.target.value as DocoRole)}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
                  >
                    {allowedRoles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {targetOptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  You do not have access to any Doco or organization that can be shared with Slack
                  yet.
                </p>
              ) : null}

              <button
                type="submit"
                disabled={!canSubmit}
                className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Authorize Slack channel
              </button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
                Channel default access
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-relaxed">
              <p>Everyone in {channelLabel} will get this shared default access:</p>
              <div className="rounded-md border border-border bg-background p-3 text-base font-semibold text-foreground">
                {selectedTarget ? selectedTarget.grantLabel : "Pick a Doco access scope"} ·{" "}
                {effectiveRole}
              </div>
              <p>
                This is the channel default for Señor Doco. It applies to everyone in this Slack
                channel.
              </p>
              {selectedTarget?.level === "org" ? (
                <p>
                  {selectedTarget.grantLabel} covers every Doco in {selectedTarget.label}.
                </p>
              ) : null}
              <p>
                People can still link their own Doco account. If they already have higher access in
                Doco, Señor Doco may use that higher personal access for their requests, but never
                more than the access they already hold.
              </p>
              <p>
                Owner-only actions, including creating Docos and changing policies, require that
                individual person to be an owner in Doco. A channel default does not grant
                owner-only actions.
              </p>
            </CardContent>
          </Card>
        </Form>
      </SingleColumnPageMain>
    </div>
  );
}

async function loadSlackChannelOptions(
  workspaceId: string,
  context: SlackChannelContext | null,
): Promise<{ channels: SlackChannelOption[]; channelLoadError: string | null }> {
  try {
    const channels = await listSlackChannels(workspaceId);
    return {
      channels: mergeContextChannel(channels, context),
      channelLoadError: null,
    };
  } catch {
    return {
      channels: mergeContextChannel([], context),
      channelLoadError:
        "Doco could not list Slack channels right now. If this opened from Slack, the current channel is still available.",
    };
  }
}

function mergeContextChannel(
  channels: SlackChannelOption[],
  context: SlackChannelContext | null,
): SlackChannelOption[] {
  if (!context || channels.some((channel) => channel.id === context.channelId)) return channels;
  return [
    {
      id: context.channelId,
      name: context.channelName,
      isPrivate: false,
    },
    ...channels,
  ];
}

function buildTargetOptions(options: ScopeOption[]): SlackTargetOption[] {
  return options.map((option) => {
    if (option.level === "org") {
      return {
        ...option,
        value: `org:${option.id}`,
        displayLabel: `${option.label}/* - all Docos in ${option.label}`,
        grantLabel: `${option.label}/*`,
      };
    }
    return {
      ...option,
      value: `doco:${option.id}`,
      displayLabel: option.label,
      grantLabel: option.label,
    };
  });
}

function parseTargetValue(value: string): { level: "org" | "doco"; id: string } | null {
  const [level, id] = value.split(":");
  if ((level !== "org" && level !== "doco") || !id) return null;
  return { level, id };
}

function readSlackChannelContext(url: URL): SlackChannelContext | null {
  const channelId = url.searchParams.get("channel_id")?.trim();
  if (!channelId) return null;
  return {
    channelId,
    channelName: url.searchParams.get("channel_name")?.trim() || channelId,
  };
}
