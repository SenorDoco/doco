// /api-keys — host-level page for managing API keys.
//
// Lists every active OAuth refresh token bound to the signed-in user
// (both agent-OAuth-flow tokens and personal-API-key tokens minted
// from this page) and lets the user mint new personal API keys.
//
// Distinct from /collaborators: that page lists humans only. API keys
// can be issued to agents OR for the user's own scripts / runtimes,
// so they live on their own page with their own affordances.

import type { DocoRole } from "@doco/db";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type ApiKeyRow,
  type ApiKeyScopeGrant,
  type ApiKeysPageData,
  type MintedApiKey,
  type ScopeOption,
  listApiKeysForCollaborator,
  loadScopeOptions,
  mintApiKey,
  revokeApiKey,
} from "~/lib/api-keys.server";
import { ALL_ROLES } from "~/lib/collaborator-invite";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }): Promise<ApiKeysPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const [keys, scopeOptions] = await Promise.all([
    listApiKeysForCollaborator(me.id),
    loadScopeOptions(me.id),
  ]);
  const host = `${url.protocol}//${url.host}`;
  return { me, keys, scopeOptions, host, justMinted: null };
}

type ActionResult =
  | { intent: "mint"; ok: true; minted: MintedApiKey }
  | { intent: "revoke"; ok: true; client_id: string }
  | { error: string };

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to manage API keys." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke") {
    const clientId = String(form.get("client_id") ?? "").trim();
    if (!clientId) return { error: "Missing client_id." };
    const ok = await revokeApiKey({ collaborator_id: me.id, client_id: clientId });
    if (!ok) return { error: "Token not found or already revoked." };
    return { intent: "revoke", ok: true, client_id: clientId };
  }

  if (intent === "mint") {
    const label = String(form.get("label") ?? "").trim();
    const rawGrants = String(form.get("grants") ?? "").trim();
    if (!rawGrants) return { error: "Pick at least one org or doco to scope this key to." };

    // grants is a JSON-encoded array of { level, target_id, role }.
    let grants: Array<{ level: "org" | "doco"; target_id: string; role: DocoRole }> = [];
    try {
      const parsed = JSON.parse(rawGrants);
      if (!Array.isArray(parsed)) throw new Error("grants must be an array");
      grants = parsed.map((g: { level?: unknown; target_id?: unknown; role?: unknown }) => {
        const level = g.level === "org" || g.level === "doco" ? g.level : null;
        const target_id = typeof g.target_id === "string" ? g.target_id : "";
        const role = typeof g.role === "string" ? (g.role as DocoRole) : ("reader" as DocoRole);
        if (!level || !target_id) throw new Error("invalid grant entry");
        return { level, target_id, role };
      });
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Malformed grants list.",
      };
    }

    try {
      const minted = await mintApiKey({ me, label, grants });
      return { intent: "mint", ok: true, minted };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to mint API key." };
    }
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "API keys · Doco" }];
}

export default function ApiKeysPage({
  loaderData,
  actionData,
}: {
  loaderData: ApiKeysPageData;
  actionData?: ActionResult;
}) {
  const { me, keys, scopeOptions } = loaderData;
  const minted =
    actionData && "intent" in actionData && actionData.intent === "mint" ? actionData.minted : null;
  const error = actionData && "error" in actionData ? actionData.error : null;

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "API keys" })} />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Long-lived Bearer tokens for programmatic access. Invite an AI agent to authenticate
            via OAuth, or mint a key directly for a script you control.
          </p>
        </header>

        <AddAgentCard
          scopeOptions={scopeOptions}
          host={loaderData.host}
          error={error}
          minted={minted}
        />

        <Card>
          <CardHeader>
            <CardTitle>All API keys</CardTitle>
            <CardDescription>
              {keys.length === 0
                ? "No active keys yet."
                : `${keys.length} active key${keys.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {keys.map((key) => (
              <KeyRow key={key.client_id} apiKey={key} />
            ))}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}

type AddAgentMode = "invite" | "generate";

function AddAgentCard({
  scopeOptions,
  host,
  error,
  minted,
}: {
  scopeOptions: ScopeOption[];
  host: string;
  error: string | null;
  minted: MintedApiKey | null;
}) {
  // Two ways to onboard an agent:
  //   - "invite":  copy a prompt that points the agent at /protocol/agent-oauth-recipe
  //                and /device; the agent drives its own OAuth flow.
  //   - "generate": pick scope + role and mint a Bearer token directly.
  // Default to "invite" because the OAuth flow is what most agents land
  // on (chat-only runtimes, MCP clients); the direct mint is the escape
  // hatch for scripts and CI.
  const [mode, setMode] = useState<AddAgentMode>("invite");
  // Switching modes after a successful mint shouldn't keep the
  // just-minted token visible under the wrong tab.
  const showMinted = mode === "generate" && minted !== null;
  const showError = error !== null && (mode === "generate" || mode === "invite");

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div
          role="tablist"
          aria-label="Onboarding mode"
          className="inline-flex rounded-md border border-border bg-background p-0.5 text-xs"
        >
          <ModeButton
            mode="invite"
            current={mode}
            onSelect={setMode}
            label="Invite AI agent"
            testid="add-agent-mode-invite"
          />
          <ModeButton
            mode="generate"
            current={mode}
            onSelect={setMode}
            label="Generate API key"
            testid="add-agent-mode-generate"
          />
        </div>

        {mode === "invite" ? (
          <InviteAgentPanel host={host} />
        ) : (
          <GenerateKeyPanel scopeOptions={scopeOptions} />
        )}

        {showError ? (
          <p className="text-sm text-destructive" data-testid="api-key-error">
            {error}
          </p>
        ) : null}

        {showMinted ? <MintedReveal minted={minted} /> : null}
      </CardContent>
    </Card>
  );
}

function ModeButton({
  mode,
  current,
  onSelect,
  label,
  testid,
}: {
  mode: AddAgentMode;
  current: AddAgentMode;
  onSelect: (m: AddAgentMode) => void;
  label: string;
  testid: string;
}) {
  const active = mode === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={() => onSelect(mode)}
      className={
        active
          ? "rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
          : "rounded-md px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}

function InviteAgentPanel({ host }: { host: string }) {
  const recipeUrl = `${host}/protocol/agent-oauth-recipe`;
  const deviceUrl = `${host}/device`;
  const prompt = [
    `Let's collaborate with Doco on this project. The host is ${host}.`,
    "",
    `To get programmatic access, follow the OAuth recipe at ${recipeUrl}. If you can bind a local TCP port and open a browser, use Recipe A (localhost-loopback). If you can't (chat-only / sandboxed runtimes), use Recipe B (RFC 8628 Device Authorization Grant) — you'll show me a short code and I'll approve at ${deviceUrl}.`,
    "",
    "At the approve screen I'll pick which orgs and docos you can read/write and at what role (reader / author / approver / owner) per org or doco, so no scoping is needed up front.",
  ].join("\n");
  return <AgentPromptBlock body={prompt} />;
}

function AgentPromptBlock({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Copy this prompt and paste it into your AI agent. The agent will drive the OAuth flow and
        you'll approve at <code className="font-mono">/device</code> in your browser.
      </p>
      <pre
        className="neu-surface rounded-md bg-card p-3 text-[11px] whitespace-pre-wrap break-words"
        data-testid="invite-agent-prompt"
      >
        {body}
      </pre>
      <div className="flex justify-end">
        <button
          type="button"
          data-testid="invite-agent-copy"
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              void navigator.clipboard.writeText(body).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }
          }}
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
        >
          {copied ? "Copied!" : "Copy prompt"}
        </button>
      </div>
    </div>
  );
}

function GenerateKeyPanel({ scopeOptions }: { scopeOptions: ScopeOption[] }) {
  const navigation = useNavigation();
  const submitting =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "mint";

  const [label, setLabel] = useState("");

  // Single combined Org / Doco dropdown, matching the collaborator
  // invite UX (collaborator-invite-cards.tsx). Each option carries the
  // user's role on that target so the Role dropdown can constrain its
  // choices to roles at or below the user's own.
  const combinedOptions = useMemo(
    () =>
      scopeOptions
        .map((opt) => ({
          key: `${opt.level}:${opt.id}`,
          level: opt.level,
          id: opt.id,
          label: opt.label,
          myRole: opt.myRole,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [scopeOptions],
  );
  const noScopes = combinedOptions.length === 0;
  const [selectedKey, setSelectedKey] = useState<string>(combinedOptions[0]?.key ?? "");
  useEffect(() => {
    if (noScopes) {
      if (selectedKey !== "") setSelectedKey("");
      return;
    }
    if (!combinedOptions.some((opt) => opt.key === selectedKey)) {
      setSelectedKey(combinedOptions[0]?.key ?? "");
    }
  }, [combinedOptions, noScopes, selectedKey]);
  const selected = combinedOptions.find((o) => o.key === selectedKey) ?? null;
  const maxRole = selected?.myRole ?? "reader";
  const allowedRoles = ALL_ROLES.filter((r) => rankOrZero(r) <= rankOrZero(maxRole));
  const [role, setRole] = useState<DocoRole>(maxRole);
  useEffect(() => {
    if (!allowedRoles.includes(role)) setRole(maxRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const grantsPayload = useMemo(() => {
    if (!selected) return "[]";
    return JSON.stringify([{ level: selected.level, target_id: selected.id, role }]);
  }, [selected, role]);

  return (
    <Form method="post" className="flex flex-col gap-3" data-testid="generate-api-key-form">
      <input type="hidden" name="intent" value="mint" />
      <input type="hidden" name="grants" value={grantsPayload} />

      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Label
        </span>
        <input
          type="text"
          name="label"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder="e.g. ci-pipeline, my-script, claude-code-laptop"
          data-testid="api-key-label"
          className="block w-full max-w-md rounded-md px-2 py-1 text-sm font-mono"
        />
      </label>

      {noScopes ? (
        <p className="text-sm text-muted-foreground">
          You aren't a member of any org or doco yet. Join or create one to mint a key.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-start gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Org / Doco
              </span>
              <select
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.currentTarget.value)}
                data-testid="api-key-target"
                className="rounded-md px-3 py-2"
              >
                {combinedOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    [{opt.level}] {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.currentTarget.value as DocoRole)}
                data-testid="api-key-role"
                className="rounded-md px-3 py-2"
              >
                {allowedRoles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="api-key-submit"
              disabled={submitting || !label.trim() || !selected}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Generating…" : "Generate API key"}
            </button>
          </div>
        </>
      )}
    </Form>
  );
}

function rankOrZero(role: DocoRole): number {
  return role === "owner" ? 3 : role === "approver" ? 2 : role === "author" ? 1 : 0;
}

function MintedReveal({ minted }: { minted: MintedApiKey }) {
  const [copied, setCopied] = useState(false);
  const expiresIn = formatExpiresIn(minted.expires_in);
  return (
    <div
      className="mt-4 rounded-md border border-primary bg-primary/5 p-3 space-y-2"
      data-testid="api-key-minted"
    >
      <p className="text-sm font-semibold">API key minted — copy it now</p>
      <p className="text-xs text-muted-foreground">
        This access token body is shown ONCE. Save it in your script's secret store; if you lose it,
        revoke the key and mint a new one. Access token expires in {expiresIn} but rotates
        automatically — use the refresh token below to mint a fresh one when it expires.
      </p>
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Access token
        </div>
        <pre
          className="overflow-x-auto rounded bg-background px-2 py-1 text-xs font-mono"
          data-testid="api-key-access-token"
        >
          {minted.access_token}
        </pre>
      </div>
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Refresh token
        </div>
        <pre
          className="overflow-x-auto rounded bg-background px-2 py-1 text-xs font-mono"
          data-testid="api-key-refresh-token"
        >
          {minted.refresh_token}
        </pre>
      </div>
      <button
        type="button"
        data-testid="api-key-copy"
        onClick={async () => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(minted.access_token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="neu-button rounded-md px-2 py-1 text-xs"
      >
        {copied ? "Copied!" : "Copy access token"}
      </button>
      <div className="text-xs text-muted-foreground">
        Scope:{" "}
        {minted.scope_grants.length === 0 ? (
          <em>none</em>
        ) : (
          minted.scope_grants.map((g) => (
            <span key={`${g.level}:${g.target_id}`} className="mr-2">
              <strong>{g.target_label}</strong> ({g.level}, {g.role})
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function formatExpiresIn(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function KeyRow({ apiKey }: { apiKey: ApiKeyRow }) {
  const fetcher = useFetcher<ActionResult>();
  const revoking = fetcher.state !== "idle";
  return (
    <div
      data-testid={`key-row-${apiKey.client_id}`}
      className="neu-surface flex flex-wrap items-start justify-between gap-3 rounded-md bg-card px-3 py-2 text-xs"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{apiKey.client_name}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {apiKey.source}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>Granted {formatDate(apiKey.granted_at)}</span>
          <span>·</span>
          <span>
            {apiKey.last_used_at ? `Last used ${formatDate(apiKey.last_used_at)}` : "Never used"}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {apiKey.scope_grants.length === 0 ? (
            <span className="text-muted-foreground">No active scopes</span>
          ) : (
            apiKey.scope_grants.map((g) => (
              <ScopeChip key={`${g.level}:${g.target_id}`} grant={g} />
            ))
          )}
        </div>
      </div>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="client_id" value={apiKey.client_id} />
        <button
          type="submit"
          disabled={revoking}
          data-testid={`revoke-${apiKey.client_id}`}
          onClick={(e) => {
            if (!confirm(`Revoke "${apiKey.client_name}"? This cannot be undone.`)) {
              e.preventDefault();
            }
          }}
          className="neu-button rounded-md px-2 py-1 text-xs text-destructive disabled:opacity-50"
        >
          {revoking ? "Revoking…" : "Revoke"}
        </button>
      </fetcher.Form>
    </div>
  );
}

function ScopeChip({ grant }: { grant: ApiKeyScopeGrant }) {
  return (
    <Link
      to={grant.target_link}
      className="neu-button inline-flex items-center rounded-full px-2 py-0.5 text-[11px]"
      title={`${grant.target_label} — ${grant.role}`}
    >
      <span className="mr-1 text-[9px] uppercase tracking-wide text-muted-foreground">
        {grant.level}
      </span>
      {grant.target_label}
      <span className="ml-1 text-muted-foreground">· {grant.role}</span>
    </Link>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
