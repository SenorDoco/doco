// /integrations — host-level group-chat integration setup.
//
// The page gives Slack / Google Chat / Discord connectors a shared
// authorization surface: the requester picks the channel-default Doco
// target + role, sees the exact consent copy, and cannot grant above
// their own Doco access.

import { Bot, Check, Copy, Hash, MessageSquare, ShieldCheck } from "lucide-react";
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

interface ProviderOption {
  id: ProviderId;
  label: string;
  channelPlaceholder: string;
}

interface IntegrationsPageData {
  me: CurrentPrincipal;
  scopeOptions: ScopeOption[];
}

const PROVIDERS: ProviderOption[] = [
  { id: "slack", label: "Slack", channelPlaceholder: "#product" },
  { id: "google-chat", label: "Google Chat", channelPlaceholder: "Product room" },
  { id: "discord", label: "Discord", channelPlaceholder: "#product" },
  { id: "other", label: "Other group chat", channelPlaceholder: "Team channel" },
];

export async function loader({ request }: { request: Request }): Promise<IntegrationsPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  return {
    me,
    scopeOptions: await loadScopeOptions(me.id),
  };
}

export function meta() {
  return [{ title: "Integrations · Doco" }];
}

export default function IntegrationsPage({ loaderData }: { loaderData: IntegrationsPageData }) {
  const { me, scopeOptions } = loaderData;
  const [providerId, setProviderId] = useState<ProviderId>("slack");
  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];
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
  const [selectedRole, setSelectedRole] = useState(defaultRole ?? "reader");
  const effectiveRole = allowedRoles.includes(selectedRole)
    ? selectedRole
    : (defaultRole ?? allowedRoles[0] ?? "reader");
  const capability = selectedTarget
    ? canSetChannelDefaultAccess({
        personalRole: selectedTarget.myRole,
        requestedRole: effectiveRole,
      })
    : { ok: false, error: "Pick a target for the channel default." };
  const preview = useMemo(() => {
    if (!selectedTarget) return "";
    return formatConnectionAuthorizationPreview({
      channelName: channelName.trim() || provider.channelPlaceholder,
      requesterLabel: me.username,
      defaultTargets: [chatTargetFromScope(selectedTarget, effectiveRole)],
    });
  }, [channelName, effectiveRole, me.username, provider.channelPlaceholder, selectedTarget]);
  const [copied, setCopied] = useState(false);

  function selectProvider(next: ProviderOption) {
    setProviderId(next.id);
    setChannelName(next.channelPlaceholder);
    setCopied(false);
  }

  function selectTarget(targetId: string) {
    const next = scopeOptions.find((option) => option.id === targetId);
    setSelectedTargetId(targetId);
    if (!next) return;
    setSelectedRole(rankOf(next.myRole) >= rankOf("author") ? "author" : next.myRole);
    setCopied(false);
  }

  async function copyPreview() {
    if (!preview) return;
    await navigator.clipboard.writeText(preview);
    setCopied(true);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="space-y-6 py-8">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Integrations" })} />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            Connect Señor Doco to group chats with explicit channel-default access.
          </p>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          {PROVIDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => selectProvider(option)}
              className={`neu-button flex min-h-24 flex-col items-start justify-between rounded-md border border-border p-4 text-left ${
                option.id === provider.id ? "text-primary" : "text-foreground hover:text-primary"
              }`}
            >
              <MessageSquare className="h-5 w-5" aria-hidden="true" />
              <span className="font-semibold">{option.label}</span>
            </button>
          ))}
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card>
            <CardHeader>
              <CardTitle>Channel authorization</CardTitle>
              <CardDescription>
                The selected role becomes the default access for everyone in that chat.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,240px)]">
                <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Channel
                  <span className="relative">
                    <Hash
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <input
                      type="text"
                      value={channelName}
                      onChange={(event) => {
                        setChannelName(event.target.value);
                        setCopied(false);
                      }}
                      className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground"
                    />
                  </span>
                </label>

                <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Provider
                  <select
                    value={provider.id}
                    onChange={(event) => {
                      const next = PROVIDERS.find((p) => p.id === event.target.value);
                      if (next) selectProvider(next);
                    }}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  >
                    {PROVIDERS.map((option) => (
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
                    onChange={(event) => selectTarget(event.target.value)}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
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
                    onChange={(event) => {
                      setSelectedRole(event.target.value as typeof effectiveRole);
                      setCopied(false);
                    }}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
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
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-4 text-xs leading-relaxed text-foreground">
                  {preview}
                </pre>
              ) : (
                <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
                  No accessible docos or orgs yet.
                </div>
              )}

              <button
                type="button"
                disabled={!preview}
                onClick={() => void copyPreview()}
                className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy authorization message"}
              </button>
            </CardContent>
          </Card>

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
