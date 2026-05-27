// /integrations — host-level group-chat installation flow.
//
// Installation comes before authorization. The user first installs
// Señor Doco into Slack / Google Chat / Discord, then chooses the
// channel-default Doco access for the installed workspace.

import type { DocoRole } from "@doco/db";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  Hash,
  MessageSquare,
  Plug,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Form, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { type ScopeOption, loadScopeOptions } from "~/lib/api-keys.server";
import { ALL_ROLES, rankOf } from "~/lib/collaborator-invite";
import {
  type ChatAccessTarget,
  canSetChannelDefaultAccess,
  formatConnectionAuthorizationPreview,
} from "~/lib/group-chat-ux";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import {
  type SlackInstallationSummary,
  getSlackConfig,
  listSlackInstallations,
  saveSlackChannelConnection,
} from "~/lib/slack.server";

type ProviderId = "slack" | "google-chat" | "discord" | "other";

interface ProviderDefinition {
  id: ProviderId;
  label: string;
  installEnv?: string;
  setupSummary: string;
  channelLabel: string;
  channelPlaceholder: string;
}

interface ProviderOption extends Omit<ProviderDefinition, "installEnv"> {
  installHref: string | null;
}

interface IntegrationsPageData {
  me: CurrentPrincipal;
  initialProviderId: ProviderId;
  notice: string | null;
  providers: ProviderOption[];
  scopeOptions: ScopeOption[];
  slackInstallations: SlackInstallationSummary[];
  slackChannelContext: SlackChannelContext | null;
}

interface SlackChannelContext {
  teamId: string;
  teamName: string | null;
  channelId: string;
  channelName: string;
}

const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "slack",
    label: "Slack",
    setupSummary: "Add the Slack app credentials to the deployment.",
    channelLabel: "Slack channel",
    channelPlaceholder: "Run /doco connect from Slack",
  },
  {
    id: "google-chat",
    label: "Google Chat",
    installEnv: "DOCO_GOOGLE_CHAT_INSTALL_URL",
    setupSummary: "Create and approve a Google Chat app for this Doco deployment.",
    channelLabel: "Space",
    channelPlaceholder: "Product room",
  },
  {
    id: "discord",
    label: "Discord",
    installEnv: "DOCO_DISCORD_INSTALL_URL",
    setupSummary: "Create and approve a Discord app for this Doco deployment.",
    channelLabel: "Discord channel",
    channelPlaceholder: "#product",
  },
  {
    id: "other",
    label: "Other group chat",
    installEnv: "DOCO_GROUP_CHAT_INSTALL_URL",
    setupSummary: "Configure a custom group-chat installation URL for this Doco deployment.",
    channelLabel: "Channel",
    channelPlaceholder: "Team channel",
  },
];

export async function loader({ request }: { request: Request }): Promise<IntegrationsPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  return {
    me,
    initialProviderId: readProviderId(url.searchParams.get("provider")) ?? "slack",
    notice: readNotice(url),
    providers: loadProviders(),
    scopeOptions: await loadScopeOptions(me.id),
    slackInstallations: await listSlackInstallations(),
    slackChannelContext: readSlackChannelContext(url),
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
  const intent = String(form.get("intent") ?? "");
  if (intent !== "save_slack_channel_default") {
    return Response.json({ error: "unknown_intent" }, { status: 400 });
  }

  const teamId = String(form.get("team_id") ?? "").trim();
  const channelId = String(form.get("channel_id") ?? "").trim();
  const channelName = String(form.get("channel_name") ?? "").trim();
  const targetLevel = form.get("target_level") === "org" ? "org" : "doco";
  const targetId = String(form.get("target_id") ?? "").trim();
  const role = String(form.get("role") ?? "") as DocoRole;

  if (!teamId || !channelId || !targetId) {
    return Response.json({ error: "missing_channel_or_target" }, { status: 400 });
  }
  if (!ALL_ROLES.includes(role)) {
    return Response.json({ error: "invalid_role" }, { status: 400 });
  }

  const scopeOptions = await loadScopeOptions(me.id);
  const target = scopeOptions.find(
    (option) => option.level === targetLevel && option.id === targetId,
  );
  if (!target) {
    return Response.json({ error: "target_not_available" }, { status: 403 });
  }
  const capability = canSetChannelDefaultAccess({
    personalRole: target.myRole,
    requestedRole: role,
  });
  if (!capability.ok) {
    return Response.json({ error: capability.error ?? "role_not_allowed" }, { status: 403 });
  }

  await saveSlackChannelConnection({
    workspaceId: teamId,
    channelId,
    channelName,
    targetLevel,
    targetId,
    role,
    createdByCollaboratorId: me.id,
  });

  throw redirect(
    `/integrations?provider=slack&connected=${encodeURIComponent(channelName || channelId)}`,
  );
}

export function meta() {
  return [{ title: "Integrations · Doco" }];
}

export default function IntegrationsPage({ loaderData }: { loaderData: IntegrationsPageData }) {
  const {
    initialProviderId,
    me,
    notice,
    providers,
    scopeOptions,
    slackChannelContext,
    slackInstallations,
  } = loaderData;
  const [providerId, setProviderId] = useState<ProviderId>(initialProviderId);
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const slackDisplayChannel = slackChannelContext
    ? `#${slackChannelContext.channelName.replace(/^#/, "")}`
    : provider.channelPlaceholder;
  const [channelName, setChannelName] = useState(slackDisplayChannel);
  const [selectedTargetId, setSelectedTargetId] = useState(scopeOptions[0]?.id ?? "");
  const selectedTarget = scopeOptions.find((option) => option.id === selectedTargetId);
  const allowedRoles = selectedTarget
    ? ALL_ROLES.filter((role) => rankOf(role) <= rankOf(selectedTarget.myRole))
    : [];
  const defaultRole =
    selectedTarget && rankOf(selectedTarget.myRole) >= rankOf("author")
      ? "author"
      : selectedTarget?.myRole;
  const [selectedRole, setSelectedRole] = useState<DocoRole>(defaultRole ?? "reader");
  const effectiveRole = allowedRoles.includes(selectedRole)
    ? selectedRole
    : (defaultRole ?? allowedRoles[0] ?? "reader");
  const capability = selectedTarget
    ? canSetChannelDefaultAccess({
        personalRole: selectedTarget.myRole,
        requestedRole: effectiveRole,
      })
    : { ok: false, error: "Pick a target for the channel default." };
  const hasSlackChannelContext = provider.id !== "slack" || Boolean(slackChannelContext);
  const canConfigureDefault = Boolean(
    provider.installHref && selectedTarget && capability.ok && hasSlackChannelContext,
  );
  const preview = useMemo(() => {
    if (!selectedTarget) return "";
    return formatConnectionAuthorizationPreview({
      channelName: channelName.trim() || provider.channelPlaceholder,
      requesterLabel: me.username,
      defaultTargets: [chatTargetFromScope(selectedTarget, effectiveRole)],
    });
  }, [channelName, effectiveRole, me.username, provider.channelPlaceholder, selectedTarget]);

  function selectProvider(next: ProviderOption) {
    setProviderId(next.id);
    setChannelName(next.id === "slack" ? slackDisplayChannel : next.channelPlaceholder);
  }

  function selectTarget(targetId: string) {
    const next = scopeOptions.find((option) => option.id === targetId);
    setSelectedTargetId(targetId);
    if (!next) return;
    setSelectedRole(rankOf(next.myRole) >= rankOf("author") ? "author" : next.myRole);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Integrations" })} />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            Install Señor Doco into a chat workspace, then choose the channel default access.
          </p>
        </header>

        {notice ? (
          <div className="rounded-md border border-border bg-background p-3 text-sm text-foreground">
            {notice}
          </div>
        ) : null}

        <section className="grid gap-3 md:grid-cols-4">
          {providers.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => selectProvider(option)}
              className={`neu-button flex min-h-28 flex-col items-start justify-between rounded-md border border-border p-4 text-left ${
                option.id === provider.id ? "text-primary" : "text-foreground hover:text-primary"
              }`}
            >
              <MessageSquare className="h-5 w-5" aria-hidden="true" />
              <span>
                <span className="block font-semibold">{option.label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {option.installHref ? "Ready to install" : "Setup required"}
                </span>
              </span>
            </button>
          ))}
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>
                  {provider.installHref
                    ? `1. Install Señor Doco in ${provider.label}`
                    : `${provider.label} is not available yet`}
                </CardTitle>
                <CardDescription>
                  {provider.installHref
                    ? "The chat platform must approve the app before Doco can see channels or receive messages."
                    : "This Doco deployment does not have a group-chat app ready to install for this provider."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {provider.installHref ? (
                  <a
                    href={provider.installHref}
                    className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    Install Señor Doco in {provider.label}
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground opacity-50"
                  >
                    Nothing to install yet
                  </button>
                )}
                <div className="grid gap-3 md:grid-cols-3">
                  <InstallStep
                    icon={<Plug className="h-4 w-4" aria-hidden="true" />}
                    title="Install app"
                    body={`${provider.label} asks a workspace admin to approve Señor Doco.`}
                  />
                  <InstallStep
                    icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
                    title="Add to channel"
                    body={
                      provider.id === "slack"
                        ? "Invite Señor Doco, then run /doco connect in that channel."
                        : "Invite Señor Doco into the channel or space where it should respond."
                    }
                  />
                  <InstallStep
                    icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                    title="Set default access"
                    body="Pick the org/doco and default role for that channel."
                  />
                </div>
                {provider.id === "slack" && provider.installHref ? (
                  <SlackWorkspaceStatus
                    installations={slackInstallations}
                    channelContext={slackChannelContext}
                  />
                ) : null}
                {provider.installHref ? null : (
                  <div className="space-y-3 rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
                    <p>
                      There is no {provider.label} app connected to this Doco deployment yet. There
                      is nothing for a workspace admin to approve from this screen right now.
                    </p>
                    <details>
                      <summary className="cursor-pointer font-semibold text-foreground">
                        Deployment setup checklist
                      </summary>
                      <div className="mt-2 space-y-2 text-xs leading-relaxed">
                        <p>{provider.setupSummary}</p>
                        <p>
                          After the chat app exists, add its install link to the deployment
                          configuration. Then this page will show the install button to users.
                        </p>
                      </div>
                    </details>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className={provider.installHref ? "" : "opacity-75"}>
              <CardHeader>
                <CardTitle>2. Set channel default access</CardTitle>
                <CardDescription>
                  This is shown after the app is installed and the channel is known.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Form method="post" className="space-y-4">
                  <input type="hidden" name="intent" value="save_slack_channel_default" />
                  <input type="hidden" name="team_id" value={slackChannelContext?.teamId ?? ""} />
                  <input
                    type="hidden"
                    name="channel_id"
                    value={slackChannelContext?.channelId ?? ""}
                  />
                  <input
                    type="hidden"
                    name="channel_name"
                    value={slackChannelContext?.channelName ?? ""}
                  />
                  <input type="hidden" name="target_level" value={selectedTarget?.level ?? ""} />
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                    <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {provider.channelLabel}
                      <span className="relative">
                        <Hash
                          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <input
                          type="text"
                          value={channelName}
                          disabled={provider.id === "slack" || !provider.installHref}
                          onChange={(event) => setChannelName(event.target.value)}
                          className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground disabled:opacity-60"
                        />
                      </span>
                    </label>

                    <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Provider
                      <select
                        value={provider.id}
                        onChange={(event) => {
                          const next = providers.find((p) => p.id === event.target.value);
                          if (next) selectProvider(next);
                        }}
                        className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                      >
                        {providers.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                    <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Doco / org
                      <select
                        name="target_id"
                        value={selectedTargetId}
                        disabled={!provider.installHref || !hasSlackChannelContext}
                        onChange={(event) => selectTarget(event.target.value)}
                        className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
                      >
                        {scopeOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            [{option.level}] {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Default role
                      <select
                        name="role"
                        value={effectiveRole}
                        disabled={!provider.installHref || !hasSlackChannelContext}
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

                  {provider.id === "slack" && !slackChannelContext ? (
                    <p className="text-sm text-muted-foreground">
                      Run <code className="rounded bg-input px-1 py-0.5">/doco connect</code> in the
                      Slack channel to open this step with the channel already selected.
                    </p>
                  ) : null}

                  {capability.ok ? null : (
                    <p className="text-sm text-destructive">{capability.error}</p>
                  )}

                  {preview ? (
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">Authorization preview</h3>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-4 text-xs leading-relaxed text-foreground">
                        {preview}
                      </pre>
                    </div>
                  ) : (
                    <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
                      No accessible docos or orgs yet.
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!canConfigureDefault}
                    className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Save channel default
                  </button>
                </Form>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Access rules</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <RuleRow
                icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                title="Channel default"
                body="Everyone in the chat gets this baseline."
              />
              <RuleRow
                icon={<Bot className="h-4 w-4" aria-hidden="true" />}
                title="Personal access"
                body="Linked users can use higher access they already hold."
              />
              <RuleRow
                icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                title="Owner actions"
                body="Creating docos and changing policies require owner."
              />
              <RuleRow
                icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
                title="Invites"
                body="Collaborator invites go by direct message."
              />
            </CardContent>
          </Card>
        </div>
      </SingleColumnPageMain>
    </div>
  );
}

function InstallStep({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-primary">
        {icon}
      </span>
      <span className="mt-3 block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{body}</span>
    </div>
  );
}

function SlackWorkspaceStatus({
  installations,
  channelContext,
}: {
  installations: SlackInstallationSummary[];
  channelContext: SlackChannelContext | null;
}) {
  if (channelContext) {
    return (
      <div className="rounded-md border border-border bg-background p-3 text-sm">
        <span className="block font-semibold text-foreground">
          Configuring #{channelContext.channelName.replace(/^#/, "")}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          Slack workspace: {channelContext.teamName ?? channelContext.teamId}. Choose the Doco and
          role below to save the channel default.
        </span>
      </div>
    );
  }
  if (installations.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
        No Slack workspaces have installed Señor Doco yet.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-background p-3 text-sm">
      <span className="block font-semibold text-foreground">Installed Slack workspaces</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
        {installations.map((installation) => installation.workspaceName).join(", ")}. Run{" "}
        <code className="rounded bg-input px-1 py-0.5">/doco connect</code> in a Slack channel to
        set its Doco default.
      </span>
    </div>
  );
}

function RuleRow({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-primary">
        {icon}
      </span>
      <span>
        <span className="block font-semibold text-foreground">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{body}</span>
      </span>
    </div>
  );
}

function chatTargetFromScope(
  option: ScopeOption,
  role: ChatAccessTarget["role"],
): ChatAccessTarget {
  if (option.level === "org") {
    return {
      level: "org",
      orgHandle: option.label,
      role,
      source: "channel_default",
    };
  }
  const slash = option.label.indexOf("/");
  return {
    level: "doco",
    orgHandle: slash > 0 ? option.label.slice(0, slash) : "",
    docoHandle: slash > 0 ? option.label.slice(slash + 1) : option.label,
    role,
    source: "channel_default",
  };
}

function loadProviders(): ProviderOption[] {
  const slackConfigured = getSlackConfig().configured;
  return PROVIDER_DEFINITIONS.map(({ installEnv, ...provider }) => {
    if (provider.id === "slack") {
      return {
        ...provider,
        installHref: slackConfigured ? "/integrations/slack/install" : null,
      };
    }
    return {
      ...provider,
      installHref: installEnv ? sanitizeInstallHref(process.env[installEnv]) : null,
    };
  });
}

function sanitizeInstallHref(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function readProviderId(value: string | null): ProviderId | null {
  return value === "slack" || value === "google-chat" || value === "discord" || value === "other"
    ? value
    : null;
}

function readSlackChannelContext(url: URL): SlackChannelContext | null {
  if (url.searchParams.get("provider") !== "slack") return null;
  const teamId = url.searchParams.get("team_id")?.trim();
  const channelId = url.searchParams.get("channel_id")?.trim();
  if (!teamId || !channelId) return null;
  const channelName = url.searchParams.get("channel_name")?.trim() || channelId;
  return {
    teamId,
    teamName: url.searchParams.get("team_name")?.trim() || null,
    channelId,
    channelName,
  };
}

function readNotice(url: URL): string | null {
  const installed = url.searchParams.get("slack_installed");
  if (installed) {
    return `Slack workspace installed: ${installed}. Now invite Señor Doco to a channel and run /doco connect there.`;
  }
  const connected = url.searchParams.get("connected");
  if (connected) {
    return `Saved the Slack channel default for ${connected}.`;
  }
  if (url.searchParams.get("slack_unavailable")) {
    return "Slack is not available yet for this Doco deployment.";
  }
  if (url.searchParams.get("slack_error")) {
    return "Slack installation did not complete. Try installing Señor Doco again.";
  }
  return null;
}
