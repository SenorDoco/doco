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
import { redirect } from "react-router";
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

type ProviderId = "slack" | "google-chat" | "discord" | "other";

interface ProviderDefinition {
  id: ProviderId;
  label: string;
  installEnv: string;
  channelLabel: string;
  channelPlaceholder: string;
}

interface ProviderOption extends ProviderDefinition {
  installHref: string | null;
}

interface IntegrationsPageData {
  me: CurrentPrincipal;
  providers: ProviderOption[];
  scopeOptions: ScopeOption[];
}

const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "slack",
    label: "Slack",
    installEnv: "DOCO_SLACK_INSTALL_URL",
    channelLabel: "Slack channel",
    channelPlaceholder: "#product",
  },
  {
    id: "google-chat",
    label: "Google Chat",
    installEnv: "DOCO_GOOGLE_CHAT_INSTALL_URL",
    channelLabel: "Space",
    channelPlaceholder: "Product room",
  },
  {
    id: "discord",
    label: "Discord",
    installEnv: "DOCO_DISCORD_INSTALL_URL",
    channelLabel: "Discord channel",
    channelPlaceholder: "#product",
  },
  {
    id: "other",
    label: "Other group chat",
    installEnv: "DOCO_GROUP_CHAT_INSTALL_URL",
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
    providers: loadProviders(),
    scopeOptions: await loadScopeOptions(me.id),
  };
}

export function meta() {
  return [{ title: "Integrations · Doco" }];
}

export default function IntegrationsPage({ loaderData }: { loaderData: IntegrationsPageData }) {
  const { me, providers, scopeOptions } = loaderData;
  const [providerId, setProviderId] = useState<ProviderId>("slack");
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const [channelName, setChannelName] = useState(provider.channelPlaceholder);
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
  const canConfigureDefault = Boolean(provider.installHref && selectedTarget && capability.ok);
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
    setChannelName(next.channelPlaceholder);
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
                  {option.installHref ? "Ready to install" : "Install URL not configured"}
                </span>
              </span>
            </button>
          ))}
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>1. Install Señor Doco in {provider.label}</CardTitle>
                <CardDescription>
                  The chat platform must approve the app before Doco can see channels or receive
                  messages.
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
                    Install URL not configured
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
                    body="Invite Señor Doco into the channel or space where it should respond."
                  />
                  <InstallStep
                    icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                    title="Set default access"
                    body="Pick the org/doco and default role for that channel."
                  />
                </div>
                {provider.installHref ? null : (
                  <p className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
                    This environment has no {provider.label} install link yet. A Doco operator must
                    configure {provider.installEnv} before users can install the app.
                  </p>
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
                        disabled={!provider.installHref}
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
                      value={selectedTargetId}
                      disabled={!provider.installHref}
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
                      value={effectiveRole}
                      disabled={!provider.installHref}
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
                  type="button"
                  disabled={!canConfigureDefault}
                  className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Save channel default
                </button>
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
  return PROVIDER_DEFINITIONS.map((provider) => ({
    ...provider,
    installHref: sanitizeInstallHref(process.env[provider.installEnv]),
  }));
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
