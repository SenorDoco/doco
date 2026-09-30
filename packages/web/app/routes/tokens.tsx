// /tokens — host-level page for managing access tokens.
//
// Lists every active OAuth refresh token bound to the signed-in user,
// plus access tokens minted from this page. Labelled "Tokens/MCP"
// everywhere user-facing. (Formerly served at /api-keys; that path now
// 302-redirects here — see routes/api-keys.tsx — so old links, bookmarks,
// and the navbar shortcut keep working.)
//
// Distinct from /users: that page lists who has access; this
// page manages the named credentials used by clients/scripts.

import type { DocoRole } from "@doco/db";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { hostBreadcrumb } from "~/components/breadcrumb";
import { GrantPicker } from "~/components/grant-picker";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { agentInstructions } from "~/lib/agent-instructions";
import {
  type ApiKeyGrantInput,
  type ApiKeyRow,
  type ApiKeyScopeGrant,
  type ApiKeysPageData,
  type MintedApiKey,
  type ScopeOption,
  addGrantsToApiKey,
  convertApiKeyToActor,
  listApiKeysForUser,
  loadScopeOptions,
  mintApiKey,
  revokeApiKey,
} from "~/lib/api-keys.server";
import { cn } from "~/lib/cn";
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
import { timeAgo } from "~/lib/time-ago";

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
    if (!rawGrants) return { error: "Pick at least one workspace or doco to scope this key to." };

    // "All your workspaces" composes a single actor grant. Mint a user-level
    // token with NO explicit grants — its breadth is the user's live membership
    // — carrying the grant's role as the ceiling.
    const actor = readActorGrant(rawGrants);
    if (actor) {
      try {
        const minted = await mintApiKey({
          me,
          label,
          grants: [],
          grantType: "actor",
          actorRole: actor.role,
        });
        return { intent: "mint", ok: true, minted };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Failed to mint token." };
      }
    }

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
    // "All your workspaces" CONVERTS the token to actor (replace, not widen):
    // drops its explicit grants and switches breadth to your live membership.
    const actor = readActorGrant(rawGrants);
    if (actor) {
      try {
        await convertApiKeyToActor({ me, client_id: clientId, actorRole: actor.role });
        return { intent: "add_grants", ok: true, client_id: clientId };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Failed to modify access." };
      }
    }
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

/**
 * Detect the "All your workspaces" pick in a grants payload. The picker emits a
 * single `{ level: "actor", role }` entry; returns its role ceiling (owner or
 * absent → null = full live role), or null when it isn't an actor mint.
 */
function readActorGrant(rawGrants: string): { role: DocoRole | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawGrants);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const actor = parsed.find(
    (g) => g && typeof g === "object" && (g as { level?: unknown }).level === "actor",
  );
  if (!actor) return null;
  const raw = (actor as { role?: unknown }).role;
  return { role: raw === "reader" || raw === "writer" ? raw : null };
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
        g.level === "account" || g.level === "workspace" || g.level === "doco" ? g.level : null;
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
  return [{ title: "Tokens/MCP · Doco" }];
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
      <SingleColumnPageMain className="py-6 space-y-6">
        <PageHeader breadcrumb={hostBreadcrumb({ pageLabel: "Tokens/MCP" })} title="Tokens/MCP" />

        <TokensTabs
          scopeOptions={scopeOptions}
          host={loaderData.host}
          keys={keys}
          catalog={catalog}
          error={error}
          minted={minted}
        />
      </SingleColumnPageMain>
    </div>
  );
}

type TokensTab = "add-mcp" | "generate" | "existing";

const TOKENS_TABS: { id: TokensTab; label: string; testid: string }[] = [
  { id: "add-mcp", label: "Add MCP", testid: "tokens-tab-add-mcp" },
  { id: "generate", label: "Generate tokens", testid: "tokens-tab-generate" },
  { id: "existing", label: "Existing tokens", testid: "tokens-tab-existing" },
];

function TokensTabs({
  scopeOptions,
  host,
  keys,
  catalog,
  error,
  minted,
}: {
  scopeOptions: ScopeOption[];
  host: string;
  keys: ApiKeyRow[];
  catalog: GrantCatalog;
  error: string | null;
  minted: MintedApiKey | null;
}) {
  // Three sections behind one row of tabs, styled like the perspective
  // tab strip (etched, open-bottom tabs attached to the panel below) but
  // with larger titles:
  //   - "Add MCP":         the hosted MCP connector setup — the path most
  //                        agents should use (all MCP clients).
  //   - "Generate tokens": pick scope + role and mint a Bearer token —
  //                        the escape hatch for non-MCP scripts and CI.
  //   - "Existing tokens": list and manage what's already been granted.
  // Default to "Add MCP" since the connector is the recommended onboarding.
  const [tab, setTab] = useState<TokensTab>("add-mcp");
  // A successful mint re-renders this same component instance (the route
  // isn't remounted on a Form POST), so `tab` stays on "generate" and the
  // reveal lands under the tab the user minted from.
  const showMinted = tab === "generate" && minted !== null;
  const showError = error !== null && tab === "generate";

  return (
    <div>
      <nav role="tablist" aria-label="Tokens and MCP" className="flex flex-wrap items-end">
        {TOKENS_TABS.map((t, i) => (
          <TokensTabButton
            key={t.id}
            label={t.label}
            testid={t.testid}
            active={tab === t.id}
            isFirst={i === 0}
            isLast={i === TOKENS_TABS.length - 1}
            onSelect={() => setTab(t.id)}
          />
        ))}
      </nav>
      <div
        role="tabpanel"
        className="neu-surface relative z-50 rounded-b-lg rounded-tl-none rounded-tr-lg border border-border bg-card p-6"
      >
        {tab === "add-mcp" ? (
          <ManualMcpPanel host={host} />
        ) : tab === "generate" ? (
          <div className="space-y-4">
            <GenerateKeyPanel scopeOptions={scopeOptions} />
            {showError ? (
              <p className="text-sm text-destructive" data-testid="api-key-error">
                {error}
              </p>
            ) : null}
            {showMinted ? <MintedReveal minted={minted} /> : null}
          </div>
        ) : (
          <ExistingTokensPanel keys={keys} catalog={catalog} />
        )}
      </div>
    </div>
  );
}

function TokensTabButton({
  label,
  testid,
  active,
  isFirst,
  isLast,
  onSelect,
}: {
  label: string;
  testid: string;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
}) {
  // Mirrors the perspective tab strip: adjacent tabs share one 1px line
  // (`-ml-px first:ml-0`), only the outer corners round, and the
  // open-bottom etched surface plus a `top-0.5` overlap lets the active
  // tab read as the top lip of the panel below. Inactive tabs sit under
  // the panel border (z-40); the active one rises above it (z-[60]) on a
  // matching `bg-card` so the seam disappears.
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onSelect}
      className={cn(
        "neu-surface-open-bottom relative top-0.5 -ml-px inline-flex items-center border border-border px-4 py-2 text-base font-semibold text-foreground first:ml-0",
        isFirst && "rounded-tl-lg",
        isLast && "rounded-tr-lg",
        active ? "z-[60] bg-card" : "z-40 bg-input hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

export function ExistingTokensPanel({
  keys,
  catalog,
}: {
  keys: ApiKeyRow[];
  catalog: GrantCatalog;
}) {
  // No "All access tokens" heading — the tab label already says it. The
  // count line still carries the empty state and the active-token tally.
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground" data-testid="tokens-count">
        {keys.length === 0
          ? "No active tokens yet."
          : `${keys.length} active token${keys.length === 1 ? "" : "s"}.`}
      </p>
      {keys.map((key) => (
        <KeyRow key={key.client_id} apiKey={key} catalog={catalog} />
      ))}
    </div>
  );
}

// A code box with its own Copy button. The MCP URL and the per-client
// setup commands are all things you paste somewhere, so each is copyable.
function CopyableCode({ value, testid }: { value: string; testid?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        className="min-h-12 overflow-x-auto whitespace-pre rounded-md bg-input px-4 py-3 pr-24 font-mono text-sm leading-6"
        data-testid={testid}
      >
        <code>{value}</code>
      </pre>
      <button
        type="button"
        data-testid={testid ? `${testid}-copy` : undefined}
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }
        }}
        className="neu-button absolute right-3 top-3 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export function ManualMcpPanel({ host }: { host: string }) {
  const baseUrl = host.replace(/\/+$/, "");
  // ONE hosted MCP endpoint at /mcp. Connect once; the token's grant is the
  // scope (one workspace, several, or specific docos — list_workspaces
  // enumerates the reach). No per-workspace URL to pick.
  const url = `${baseUrl}/mcp`;

  return (
    <section className="space-y-4" data-testid="manual-mcp-panel">
      {/* Step 1 — connect the MCP: the URL */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">1. Connect the MCP to your environment</h2>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Your MCP URL</p>
          <CopyableCode value={url} testid="mcp-url" />
        </div>
      </div>

      {/* Step 2 — the one agent-instructions template, as on the home page */}
      <div className="border-t border-border pt-3">
        <AgentInstructionsBlock
          title="2. Give your agent these instructions"
          instructions={agentInstructions(baseUrl)}
        />
      </div>
    </section>
  );
}

function GenerateKeyPanel({ scopeOptions }: { scopeOptions: ScopeOption[] }) {
  const navigation = useNavigation();
  const submitting =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "mint";

  const [label, setLabel] = useState("");

  // Same drill-down grant picker the collaborators page uses:
  // workspace → docos → read / write / own.
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
      // "All your workspaces" composes a single actor grant, so it counts like
      // any other pick — no special case.
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
          You aren't a member of any workspace or doco yet. Join or create one to mint a key.
        </p>
      ) : (
        <>
          <div ref={grantsRef}>
            <GrantPicker
              catalog={catalog}
              grants={grants}
              offerActor
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
      .filter((o) => o.level === "workspace")
      .map((o) => ({ id: o.id, label: o.label, maxRole: o.myRole })),
    scopeOptions
      .filter((o) => o.level === "doco")
      .map((o) => ({ id: o.id, label: o.label, maxRole: o.myRole, workspaceId: o.workspaceId })),
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
        // A regular mint always carries ≥1 grant, so an empty scope is an
        // actor token: it reaches all your workspaces.
        <em>all your workspaces</em>
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
            <span>{formatLastUsedLabel(apiKey.last_used_at)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {apiKey.grant_type === "actor" ? (
              // An actor token has no explicit grants — its breadth is your live
              // membership, capped at actor_role.
              <span className="text-muted-foreground">{actorScopeLabel(apiKey.actor_role)}</span>
            ) : apiKey.scope_grants.length === 0 ? (
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
          offerActor
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

// Serialize the picker's grants for the hidden form field. An actor grant
// (the "All your workspaces" pick) rides through verbatim so the action can
// detect it and CONVERT the token; the other levels are scoped grants the
// action merges via addGrantsToApiKey.
function grantsToPayload(
  grants: ComposedGrant[],
): { level: ComposedGrant["level"]; target_id: string; role: DocoRole; write_types: string[] }[] {
  return grants.map((g) => ({
    level: g.level,
    target_id: g.targetId,
    role: g.role,
    write_types: resolveWriteTypes(g.role, g.writeTypes),
  }));
}

/** Scope summary for an actor ("All your workspaces") token, with its ceiling. */
export function actorScopeLabel(actorRole: DocoRole | null): string {
  return `All your workspaces${actorRole ? ` · ${actorRole}` : ""}`;
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

export function formatLastUsedLabel(iso: string | null, now = new Date()): string {
  if (!iso) return "Never used";
  return `Last used ${timeAgo(iso, now)}`;
}
