// /api-keys — host-level page for managing personal access tokens.
//
// Lists every active OAuth refresh token bound to the signed-in user
// or one of their named agent users, plus personal access tokens
// minted from this page. (URL kept as /api-keys to preserve existing
// links and the navbar shortcut; the page is labelled "Personal access
// tokens" everywhere user-facing.)
//
// Distinct from /users: that page lists who has access; this
// page manages the credentials behind those agents/scripts.

import type { DocoRole } from "@doco/db";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";
import { AgentInvitePrompt } from "~/components/agent-invite-prompt";
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
  listApiKeysForUser,
  loadScopeOptions,
  mintApiKey,
  revokeApiKey,
} from "~/lib/api-keys.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { ALL_ROLES } from "~/lib/user-invite";

export async function loader({ request }: { request: Request }): Promise<ApiKeysPageData> {
  const me = await getCurrentPrincipal(request);
  const url = new URL(request.url);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const [keys, scopeOptions] = await Promise.all([
    listApiKeysForUser(me.id),
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
  if (!me) return { error: "Sign in to manage personal access tokens." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke") {
    const clientId = String(form.get("client_id") ?? "").trim();
    if (!clientId) return { error: "Missing client_id." };
    const ok = await revokeApiKey({ user_id: me.id, client_id: clientId });
    if (!ok) return { error: "Token not found or already revoked." };
    return { intent: "revoke", ok: true, client_id: clientId };
  }

  if (intent === "mint") {
    const label = String(form.get("label") ?? "").trim();
    const rawGrants = String(form.get("grants") ?? "").trim();
    if (!rawGrants) return { error: "Pick at least one org or doco to scope this key to." };

    // grants is a JSON-encoded array of { level, target_id, role,
    // write_types? } — write_types narrows write to specific neuron/
    // synapse types (decision_per_type_write_grants).
    let grants: Array<{
      level: "org" | "doco";
      target_id: string;
      role: DocoRole;
      write_types?: string[];
    }> = [];
    try {
      const parsed = JSON.parse(rawGrants);
      if (!Array.isArray(parsed)) throw new Error("grants must be an array");
      grants = parsed.map(
        (g: { level?: unknown; target_id?: unknown; role?: unknown; write_types?: unknown }) => {
          const level = g.level === "org" || g.level === "doco" ? g.level : null;
          const target_id = typeof g.target_id === "string" ? g.target_id : "";
          const role = typeof g.role === "string" ? (g.role as DocoRole) : ("reader" as DocoRole);
          if (!level || !target_id) throw new Error("invalid grant entry");
          const write_types = Array.isArray(g.write_types)
            ? g.write_types.filter((t): t is string => typeof t === "string")
            : undefined;
          return { level, target_id, role, write_types };
        },
      );
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Malformed grants list.",
      };
    }

    const nonRotating = String(form.get("non_rotating") ?? "") === "true";
    try {
      const minted = await mintApiKey({ me, label, grants, non_rotating: nonRotating });
      return { intent: "mint", ok: true, minted };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to mint token." };
    }
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Personal access tokens · Doco" }];
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
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Personal access tokens" })} />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Personal access tokens</h1>
        </header>

        <AddAgentCard
          scopeOptions={scopeOptions}
          host={loaderData.host}
          error={error}
          minted={minted}
        />

        <Card>
          <CardHeader>
            <CardTitle>All personal access tokens</CardTitle>
            <CardDescription>
              {keys.length === 0
                ? "No active tokens yet."
                : `${keys.length} active token${keys.length === 1 ? "" : "s"}.`}
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
          className="inline-flex rounded-md border border-border bg-background p-0.5"
        >
          <ModeButton
            mode="invite"
            current={mode}
            onSelect={setMode}
            label="Invite AI agent (recommended)"
            testid="add-agent-mode-invite"
          />
          <ModeButton
            mode="generate"
            current={mode}
            onSelect={setMode}
            label="Generate token"
            testid="add-agent-mode-generate"
          />
        </div>

        {mode === "invite" ? (
          <AgentInvitePrompt host={host} />
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
          ? "rounded-md bg-primary px-3 py-1.5 text-base font-semibold text-primary-foreground"
          : "rounded-md px-3 py-1.5 text-base font-semibold text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}

function GenerateKeyPanel({ scopeOptions }: { scopeOptions: ScopeOption[] }) {
  const navigation = useNavigation();
  const submitting =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "mint";

  const [label, setLabel] = useState("");
  const [cloudEnv, setCloudEnv] = useState(false);

  // Single combined Org / Doco dropdown, matching the user
  // invite UX (user-invite-cards.tsx). Each option carries the
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
  const allowedRoles = useMemo(
    () => ALL_ROLES.filter((r) => rankOrZero(r) <= rankOrZero(maxRole)),
    [maxRole],
  );
  const [role, setRole] = useState<DocoRole>(maxRole);
  useEffect(() => {
    setRole((current) => (allowedRoles.includes(current) ? current : maxRole));
  }, [allowedRoles, maxRole]);

  const grantsPayload = useMemo(() => {
    if (!selected) return "[]";
    return JSON.stringify([{ level: selected.level, target_id: selected.id, role }]);
  }, [selected, role]);

  return (
    <Form method="post" className="flex flex-col gap-3" data-testid="generate-api-key-form">
      <input type="hidden" name="intent" value="mint" />
      <input type="hidden" name="grants" value={grantsPayload} />
      <input type="hidden" name="non_rotating" value={cloudEnv ? "true" : "false"} />

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
          <label className="flex items-start gap-2 text-sm" data-testid="api-key-cloud-env-label">
            <input
              type="checkbox"
              checked={cloudEnv}
              onChange={(e) => setCloudEnv(e.currentTarget.checked)}
              data-testid="api-key-cloud-env"
              className="mt-0.5"
            />
            <span className="text-muted-foreground">
              This agent runs in a <strong>cloud environment</strong> (Claude Code on the web,
              Codespaces, Replit…). Mint a non-rotating token to paste into the environment's
              variable config, so fresh instances inherit access without re-authorizing.
            </span>
          </label>
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="api-key-submit"
              disabled={submitting || !label.trim() || !selected}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Generating…" : cloudEnv ? "Generate cloud token" : "Generate token"}
            </button>
          </div>
        </>
      )}
    </Form>
  );
}

function rankOrZero(role: DocoRole): number {
  return role === "owner" ? 2 : role === "writer" ? 1 : 0;
}

function MintedReveal({ minted }: { minted: MintedApiKey }) {
  const [copied, setCopied] = useState<string | null>(null);
  const expiresIn = formatExpiresIn(minted.expires_in);

  const copy = async (key: string, text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  };

  const scopeLine = (
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
  );

  if (minted.non_rotating) {
    const envBlock = `DOCO_ACCESS=${minted.access_token}\nDOCO_REFRESH=${minted.refresh_token}\nDOCO_CLIENT_ID=${minted.client_id}`;
    return (
      <div
        className="mt-4 rounded-md border border-primary bg-primary/5 p-3 space-y-2"
        data-testid="api-key-minted"
      >
        <p className="text-sm font-semibold">Cloud token minted — copy it now</p>
        <p className="text-xs text-muted-foreground">
          Shown ONCE. Add these to your cloud environment's variable configuration (Claude Code on
          the web env vars, Codespaces / Replit secrets, …). Every fresh instance mints its own
          short-lived access token from this <strong>non-rotating</strong> refresh token — no
          re-authorizing. The pinned value stays valid until you revoke it below.
        </p>
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Environment variables
          </div>
          <pre
            className="overflow-x-auto whitespace-pre rounded bg-background px-2 py-1 text-xs font-mono"
            data-testid="api-key-env-block"
          >
            {envBlock}
          </pre>
        </div>
        <button
          type="button"
          data-testid="api-key-copy-env"
          onClick={() => copy("env", envBlock)}
          className="neu-button rounded-md px-2 py-1 text-xs"
        >
          {copied === "env" ? "Copied!" : "Copy all three"}
        </button>
        {scopeLine}
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-md border border-primary bg-primary/5 p-3 space-y-2"
      data-testid="api-key-minted"
    >
      <p className="text-sm font-semibold">Personal access token minted — copy it now</p>
      <p className="text-xs text-muted-foreground">
        This access token body is shown ONCE. Save it in your script's secret store; if you lose it,
        revoke the token and mint a new one. The access token expires in {expiresIn}; the refresh
        token below mints a fresh one (rotating each time) when it does.
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
        onClick={() => copy("access", minted.access_token)}
        className="neu-button rounded-md px-2 py-1 text-xs"
      >
        {copied === "access" ? "Copied!" : "Copy access token"}
      </button>
      {scopeLine}
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
