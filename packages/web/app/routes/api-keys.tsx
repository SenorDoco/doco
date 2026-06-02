// /api-keys — host-level page for managing access tokens.
//
// Lists every active OAuth refresh token bound to the signed-in user,
// plus access tokens minted from this page. (URL kept as /api-keys to preserve existing
// links and the navbar shortcut; the page is labelled "Access tokens"
// everywhere user-facing.)
//
// Distinct from /users: that page lists who has access; this
// page manages the named credentials used by clients/scripts.

import type { DocoRole } from "@doco/db";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";
import { AgentInvitePrompt } from "~/components/agent-invite-prompt";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { GrantPicker } from "~/components/grant-picker";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type ApiKeyGrantInput,
  type ApiKeyRow,
  type ApiKeyScopeGrant,
  type ApiKeysPageData,
  type MintedApiKey,
  type ScopeOption,
  addGrantsToApiKey,
  listApiKeysForUser,
  loadScopeOptions,
  mintApiKey,
  revokeApiKey,
} from "~/lib/api-keys.server";
import {
  GRANT_REQUIRED_MESSAGE,
  type GrantFormFieldKey,
  focusFirstError,
  validateGrantForm,
} from "~/lib/grant-form-validation";
import {
  type ComposedGrant,
  type ExistingGrant,
  type GrantCatalog,
  catalogFromOptions,
  resolveWriteTypes,
} from "~/lib/grant-picker";
import { getCurrentPrincipal } from "~/lib/session.server";

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
  | { intent: "add_grants"; ok: true; client_id: string }
  | { error: string };

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to manage access tokens." };

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

    let grants: ApiKeyGrantInput[] = [];
    try {
      grants = parseGrantPayload(rawGrants);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Malformed grants list.",
      };
    }

    try {
      const minted = await mintApiKey({ me, label, grants });
      return { intent: "mint", ok: true, minted };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to mint token." };
    }
  }

  if (intent === "add_grants") {
    const clientId = String(form.get("client_id") ?? "").trim();
    const rawGrants = String(form.get("grants") ?? "").trim();
    if (!clientId) return { error: "Missing client_id." };
    if (!rawGrants) return { error: "Pick at least one thing to grant access to." };
    let grants: ApiKeyGrantInput[] = [];
    try {
      grants = parseGrantPayload(rawGrants);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Malformed grants list.",
      };
    }
    try {
      await addGrantsToApiKey({ me, client_id: clientId, grants });
      return { intent: "add_grants", ok: true, client_id: clientId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to modify access." };
    }
  }

  return { error: `Unknown intent: ${intent}` };
}

function parseGrantPayload(rawGrants: string): ApiKeyGrantInput[] {
  // grants is a JSON-encoded array of { level, target_id, role,
  // write_types? } — write_types narrows write to specific node/
  // edge types (decision_per_type_write_grants).
  const parsed = JSON.parse(rawGrants);
  if (!Array.isArray(parsed)) throw new Error("grants must be an array");
  return parsed.map(
    (g: { level?: unknown; target_id?: unknown; role?: unknown; write_types?: unknown }) => {
      const level =
        g.level === "account" || g.level === "org" || g.level === "doco" ? g.level : null;
      const target_id = typeof g.target_id === "string" ? g.target_id : "";
      const role = typeof g.role === "string" ? (g.role as DocoRole) : ("reader" as DocoRole);
      // Account grants carry no target_id (the minter's account is the scope).
      if (!level || (level !== "account" && !target_id)) {
        throw new Error("invalid grant entry");
      }
      const write_types = Array.isArray(g.write_types)
        ? g.write_types.filter((t): t is string => typeof t === "string")
        : undefined;
      return { level, target_id, role, write_types };
    },
  );
}

export function meta() {
  return [{ title: "Access tokens · Doco" }];
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
  const catalog = useMemo(() => scopeOptionsToCatalog(scopeOptions), [scopeOptions]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-8 space-y-6">
        <Breadcrumb items={hostBreadcrumb({ pageLabel: "Access tokens" })} />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Access tokens</h1>
        </header>

        <AddAgentCard
          scopeOptions={scopeOptions}
          host={loaderData.host}
          error={error}
          minted={minted}
        />

        <Card>
          <CardHeader>
            <CardTitle>All access tokens</CardTitle>
            <CardDescription>
              {keys.length === 0
                ? "No active tokens yet."
                : `${keys.length} active token${keys.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {keys.map((key) => (
              <KeyRow key={key.client_id} apiKey={key} catalog={catalog} />
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
  //   - "invite":  copy a prompt that leads with the hosted MCP connector
  //                (read+write; the client runs OAuth itself), with the
  //                by-hand OAuth recipes as the fallback (see
  //                agent-invite-prompt.tsx).
  //   - "generate": pick scope + role and mint a Bearer token directly.
  // Default to "invite" because the hosted connector is the path most
  // agents should use (all MCP clients); the direct mint is the escape
  // hatch for non-MCP scripts and CI.
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

  // Same drill-down grant picker the collaborators page uses
  // (decision_per_type_write_grants): org → docos → read/write + per-type.
  const catalog = useMemo(() => scopeOptionsToCatalog(scopeOptions), [scopeOptions]);
  const noScopes = catalog.targets.length === 0;
  const [grants, setGrants] = useState<ComposedGrant[]>([]);
  const [errors, setErrors] = useState<Partial<Record<GrantFormFieldKey, string>>>({});
  const labelRef = useRef<HTMLInputElement>(null);
  const grantsRef = useRef<HTMLDivElement>(null);

  function clearError(field: GrantFormFieldKey) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const { [field]: _cleared, ...rest } = prev;
      return rest;
    });
  }

  // Submit is never disabled on validity, so clicking an incomplete form
  // surfaces the reason instead of doing nothing. Validate here; on failure
  // block the POST, show the app's error styling, and reveal the first field.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const found = validateGrantForm({
      name: { value: label, message: "Enter a label for this token." },
      grantCount: grants.length,
    });
    if (found.length === 0) {
      setErrors({});
      return;
    }
    e.preventDefault();
    setErrors(Object.fromEntries(found.map((f) => [f.field, f.message])));
    focusFirstError(found[0].field, { name: labelRef.current, grants: grantsRef.current });
  }

  const grantsPayload = useMemo(
    () =>
      JSON.stringify(
        grants.map((g) => ({
          level: g.level,
          target_id: g.targetId,
          role: g.role,
          write_types: resolveWriteTypes(g.role, g.writeTypes),
        })),
      ),
    [grants],
  );

  return (
    <Form
      method="post"
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
      data-testid="generate-api-key-form"
    >
      <input type="hidden" name="intent" value="mint" />
      <input type="hidden" name="grants" value={grantsPayload} />

      <div>
        <label className="block text-sm">
          <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
            Label
          </span>
          <input
            ref={labelRef}
            type="text"
            name="label"
            value={label}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setLabel(next);
              if (next.trim()) clearError("name");
            }}
            placeholder="e.g. ci-pipeline, my-script, claude-code-laptop"
            data-testid="api-key-label"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "api-key-label-error" : undefined}
            className={`block w-full max-w-md rounded-md px-2 py-1 text-sm font-mono${
              errors.name ? " border border-destructive ring-1 ring-destructive" : ""
            }`}
          />
        </label>
        {errors.name ? (
          <p id="api-key-label-error" role="alert" className="mt-1 text-xs text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      {noScopes ? (
        <p className="text-sm text-muted-foreground">
          You aren't a member of any org or doco yet. Join or create one to mint a key.
        </p>
      ) : (
        <>
          <div ref={grantsRef}>
            <GrantPicker
              catalog={catalog}
              grants={grants}
              onChange={(next) => {
                setGrants(next);
                if (next.length > 0) clearError("grants");
              }}
            />
            {errors.grants ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {errors.grants}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="api-key-submit"
              disabled={submitting}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Generating…" : "Generate token"}
            </button>
          </div>
        </>
      )}
    </Form>
  );
}

function scopeOptionsToCatalog(scopeOptions: ScopeOption[]): GrantCatalog {
  return catalogFromOptions(
    scopeOptions
      .filter((o) => o.level === "org")
      .map((o) => ({ id: o.id, label: o.label, maxRole: o.myRole })),
    scopeOptions
      .filter((o) => o.level === "doco")
      .map((o) => ({ id: o.id, label: o.label, maxRole: o.myRole, orgId: o.orgId })),
  );
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
    <div className="text-sm text-muted-foreground">
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

  const envBlock = `DOCO_ACCESS=${minted.access_token}\nDOCO_REFRESH=${minted.refresh_token}\nDOCO_CLIENT_ID=${minted.client_id}`;
  return (
    <div
      className="mt-4 rounded-md border border-primary bg-primary/5 p-3 space-y-2"
      data-testid="api-key-minted"
    >
      <p className="text-base font-semibold">Token minted — copy it now</p>
      <p className="text-sm text-muted-foreground">
        Shown ONCE. If for an agent, pin these wherever the agent runs — a repo <code>.env</code>,
        cloud env vars (Claude Code on the web, Codespaces, Replit…), or CI secrets. The refresh
        token is non-rotating, so every fresh instance mints its own short-lived access token from
        it (the access token expires in {expiresIn}) — no re-authorizing. The value stays valid
        until you revoke it below.
      </p>
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Environment variables
        </div>
        <pre
          className="overflow-x-auto whitespace-pre rounded bg-background px-2 py-1 text-sm font-mono"
          data-testid="api-key-env-block"
        >
          {envBlock}
        </pre>
      </div>
      <button
        type="button"
        data-testid="api-key-copy-env"
        onClick={() => copy("env", envBlock)}
        className="neu-button rounded-md px-2 py-1 text-sm"
      >
        {copied === "env" ? "Copied!" : "Copy all three"}
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

function KeyRow({ apiKey, catalog }: { apiKey: ApiKeyRow; catalog: GrantCatalog }) {
  const fetcher = useFetcher<ActionResult>();
  const revoking = fetcher.state !== "idle";
  const [adding, setAdding] = useState(false);
  return (
    <div
      data-testid={`key-row-${apiKey.client_id}`}
      className="neu-surface rounded-md bg-card px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
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
        <button
          type="button"
          data-testid={`add-access-${apiKey.client_id}`}
          onClick={() => setAdding((v) => !v)}
          className="neu-button rounded-md px-2 py-1 text-xs"
        >
          {adding ? "Cancel changes" : "Modify access"}
        </button>
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
      {adding ? (
        <TokenAddAccessForm apiKey={apiKey} catalog={catalog} onDone={() => setAdding(false)} />
      ) : null}
    </div>
  );
}

function TokenAddAccessForm({
  apiKey,
  catalog,
  onDone,
}: {
  apiKey: ApiKeyRow;
  catalog: GrantCatalog;
  onDone: () => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const [grants, setGrants] = useState<ComposedGrant[]>([]);
  const [grantError, setGrantError] = useState<string | null>(null);
  const grantsRef = useRef<HTMLDivElement>(null);
  const done =
    fetcher.state === "idle" &&
    fetcher.data &&
    "intent" in fetcher.data &&
    fetcher.data.intent === "add_grants";
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  useEffect(() => {
    if (done) {
      setGrants([]);
      onDone();
    }
  }, [done, onDone]);
  const payload = useMemo(() => JSON.stringify(grantsToPayload(grants)), [grants]);
  const existing = useMemo<ExistingGrant[]>(
    () =>
      apiKey.scope_grants.map((g) => ({
        level: g.level,
        targetId: g.target_id,
        label: g.target_label,
        role: g.role,
        writeTypes: g.writeTypes,
      })),
    [apiKey.scope_grants],
  );

  // Submit stays clickable so an empty selection explains itself rather than
  // doing nothing.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const found = validateGrantForm({ grantCount: grants.length });
    if (found.length === 0) {
      setGrantError(null);
      return;
    }
    e.preventDefault();
    setGrantError(found[0].message);
    focusFirstError("grants", { grants: grantsRef.current });
  }

  return (
    <fetcher.Form
      method="post"
      onSubmit={handleSubmit}
      className="mt-3 space-y-3"
      data-testid={`token-add-${apiKey.client_id}`}
    >
      <input type="hidden" name="intent" value="add_grants" />
      <input type="hidden" name="client_id" value={apiKey.client_id} />
      <input type="hidden" name="grants" value={payload} />
      <div ref={grantsRef}>
        <GrantPicker
          catalog={catalog}
          grants={grants}
          onChange={(next) => {
            setGrants(next);
            if (next.length > 0) setGrantError(null);
          }}
          existing={existing}
        />
        {grantError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {grantError}
          </p>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="neu-button bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {fetcher.state !== "idle" ? "Saving…" : "Save access changes"}
        </button>
      </div>
    </fetcher.Form>
  );
}

function grantsToPayload(grants: ComposedGrant[]): ApiKeyGrantInput[] {
  return grants.map((g) => ({
    level: g.level,
    target_id: g.targetId,
    role: g.role,
    write_types: resolveWriteTypes(g.role, g.writeTypes),
  }));
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
