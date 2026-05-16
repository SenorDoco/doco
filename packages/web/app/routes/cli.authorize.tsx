// /cli/authorize?state=<nonce> — The browser-side of the CLI
// authorization handoff (decision_01KRKZM14WNA1685GN0F12WCKM).
//
// Flow:
//   1. The CLI calls POST /api/v1/cli/device-init, gets a state nonce.
//   2. CLI opens this URL in the project owner's default browser.
//   3. If not signed in, this loader bounces through /auth/github with
//      a `return` cookie so we land back here after OAuth.
//   4. The page renders a Vercel-style identity card — doco-cli@<version>,
//      hostname, IP, timestamp — plus an optional "Doco slug to create"
//      input. The project owner clicks Authorize or Deny.
//   5. On Authorize: the action mints an agent Principal (owner=project
//      owner), a session token, optionally creates a Doco directly under
//      the project owner, and flips the cli_authorization row's status
//      to "approved". The CLI's next poll consumes the token.
//
// No host-bootstrap detour. No /claim/<token> handoff.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Form, Link, redirect, useActionData } from "react-router";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { EntityId } from "@doco/shared";
import { validateDocoSlug } from "@doco/shared";
import { readFileSync } from "node:fs";
import { getDocoById, getPrincipalById, upsertEntity } from "@doco/db";
import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";
import { isMyDoco } from "~/lib/doco-access.server";
import { listAllDocos } from "~/lib/host";
import { addAgentPrincipal, createDocoInHost, reindex } from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

type LoaderError =
  | { error: "missing_state" }
  | { error: "not_found" }
  | { error: "expired" }
  | { error: "already_resolved"; status: "approved" | "exchanged" | "denied" };

type LoaderOk = {
  ok: true;
  state: string;
  cli: {
    cli_version: string;
    cli_hostname: string;
    cli_user_agent: string;
    created_at: string;
    expires_at: string;
    short_code: string;
    client_ip: string;
  };
  principal: { id: string; username: string; display_name: string };
  /**
   * Docos the signed-in project owner can pick from to bind this access
   * URL to. Empty when they have none yet — in which case the form only
   * offers the create-new path.
   */
  myDocos: Array<{
    docoId: string;
    ownerSlug: string;
    docoSlug: string;
  }>;
};

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return { error: "missing_state" } satisfies LoaderError;

  const principal = await getCurrentPrincipal(request);
  if (!principal) {
    // Bounce through GitHub OAuth and come back here after sign-in.
    const ret = `/cli/authorize?state=${encodeURIComponent(state)}`;
    return redirect(`/auth/github?return=${encodeURIComponent(ret)}`);
  }

  const store = TokenStore.forDoco(rootDir());
  const row = await store.findCliAuthorizationByState(state);
  if (!row) return { error: "not_found" } satisfies LoaderError;
  if (row.status === "expired") return { error: "expired" } satisfies LoaderError;
  if (row.status !== "pending") {
    return {
      error: "already_resolved",
      status: row.status === "approved" || row.status === "exchanged" ? row.status : "denied",
    } satisfies LoaderError;
  }

  const allDocos = await listAllDocos();
  const ownerships = await Promise.all(
    allDocos.map((d) => isMyDoco({ ownerId: d.ownerId }, principal.id)),
  );
  const myDocos = allDocos
    .filter((_, i) => ownerships[i])
    .map((d) => ({ docoId: d.docoId, ownerSlug: d.ownerSlug, docoSlug: d.docoSlug }))
    .sort((a, b) => `${a.ownerSlug}/${a.docoSlug}`.localeCompare(`${b.ownerSlug}/${b.docoSlug}`));

  return {
    ok: true,
    state,
    cli: {
      cli_version: row.cli_version,
      cli_hostname: row.cli_hostname,
      cli_user_agent: row.cli_user_agent,
      created_at: row.created_at,
      expires_at: row.expires_at,
      short_code: row.short_code,
      client_ip: clientIpFrom(request),
    },
    principal: {
      id: principal.id,
      username: principal.username,
      display_name: principal.display_name,
    },
    myDocos,
  } satisfies LoaderOk;
}

/**
 * If the named principal exists in Postgres but not as a YAML file on
 * disk, write the YAML so createDocoInHost's filesystem-walking owner
 * resolver picks it up. No-op if the file already exists. Idempotent.
 *
 * Workaround for the in-flight Postgres-as-source-of-truth migration —
 * once createDocoInHost reads owners from Postgres directly, this
 * helper goes away.
 */
async function ensureOwnerPrincipalOnDisk(root: string, principalId: string): Promise<void> {
  const dir = join(root, "principals");
  const path = join(dir, `${principalId}.yaml`);
  if (existsSync(path)) return;
  const row = await getPrincipalById(principalId);
  if (!row) throw new Error(`Principal ${principalId} not found in Postgres.`);
  // raw_yaml is JSON-encoded (the migration tool stores frontmatter as
  // JSON for easier processing); convert it back to YAML for the
  // filesystem-walking readers.
  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(row.raw_yaml) as Record<string, unknown>;
  } catch {
    fm = parseYaml(row.raw_yaml) as Record<string, unknown>;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, stringifyYaml(fm), "utf8");
}

/**
 * Mirror a freshly-created Doco's `doco.yaml` from disk into the
 * Postgres `docos` table. Companion to ensureOwnerPrincipalOnDisk —
 * createDocoInHost only writes the filesystem; the Postgres row is
 * needed by reindex (which reads from Postgres) and by the per-Doco
 * routes (which look up docos via getDocoById / `owner_slug`).
 *
 * Workaround for the in-flight Postgres-as-source-of-truth migration.
 */
async function mirrorDocoToPostgres(docoPath: string, docoId: string): Promise<void> {
  const yamlText = readFileSync(join(docoPath, "doco.yaml"), "utf8");
  const fm = parseYaml(yamlText) as Record<string, unknown>;
  await upsertEntity({
    id: docoId,
    doco_id: docoId,
    node_type: "doco",
    raw_yaml: JSON.stringify(fm),
    summary: typeof fm.summary === "string" ? fm.summary : null,
    lifecycle: typeof fm.lifecycle === "string" ? fm.lifecycle : "active",
    created_at: typeof fm.created_at === "string" ? fm.created_at : new Date().toISOString(),
    created_by: typeof fm.created_by === "string" ? fm.created_by : null,
    updated_at: typeof fm.created_at === "string" ? fm.created_at : new Date().toISOString(),
    updated_by: typeof fm.created_by === "string" ? fm.created_by : null,
  });
}

function clientIpFrom(request: Request): string {
  // Behind a proxy/edge in production; for dev this falls through to "—".
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "—";
}

type ActionResult =
  | { error: string }
  | {
      ok: true;
      approved_owner: string;
      bound_doco_slug: string;
      bound_doco_id: string;
      created_doco_slug: string | null;
      created_doco_id: string | null;
    };

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const principal = await getCurrentPrincipal(request);
  if (!principal) return { error: "Sign in first." };

  const form = await request.formData();
  const state = String(form.get("state") ?? "").trim();
  const intent = String(form.get("intent") ?? "approve");
  if (!state) return { error: "Missing state." };

  const store = TokenStore.forDoco(rootDir());
  const row = await store.findCliAuthorizationByState(state);
  if (!row) return { error: "Authorization request not found or expired." };
  if (row.status !== "pending") {
    return { error: `Authorization is already ${row.status}.` };
  }

  if (intent === "deny") {
    await store.denyCliAuthorization(state);
    return { error: "Denied. You can close this tab." };
  }

  // Mint the agent Principal owned by the project owner.
  const isoNow = new Date().toISOString();
  const agentUsername = `${principal.username}/${isoNow}`;
  let agentId: EntityId<"principal">;
  try {
    agentId = await addAgentPrincipal(rootDir(), {
      username: agentUsername,
      display_name: `Agent session for ${principal.username} (${row.cli_hostname})`,
      owner_id: principal.id as EntityId<"principal">,
      agent_metadata: {
        provider: row.cli_user_agent,
        model: row.cli_user_agent,
        capabilities: [],
        created_at: isoNow,
      },
    });
  } catch (e) {
    return { error: `Failed to create agent Principal: ${(e as Error).message}` };
  }

  // Two paths: bind the credential to an EXISTING Doco the project
  // owner already has, or CREATE a new one. The form sends `mode` =
  // "existing" | "create".
  const mode = String(form.get("mode") ?? "create");
  let boundDocoId: EntityId<"doco">;
  let boundOwnerSlug: string;
  let boundDocoSlug: string;
  let createdDocoSlug: string | null = null;
  let createdDocoId: string | null = null;

  if (mode === "existing") {
    const existingDocoId = String(form.get("existing_doco_id") ?? "").trim();
    if (!existingDocoId) {
      return { error: "Pick an existing Doco from the list." };
    }
    const docoRow = await getDocoById(existingDocoId);
    if (!docoRow) {
      return { error: `Doco ${existingDocoId} not found.` };
    }
    const owned = await isMyDoco({ ownerId: docoRow.owner_id }, principal.id);
    if (!owned) {
      return { error: "You can only bind an access URL to a Doco you own." };
    }
    boundDocoId = docoRow.id as EntityId<"doco">;
    boundOwnerSlug = docoRow.owner_slug;
    boundDocoSlug = docoRow.doco_slug;
  } else {
    const docoSlugInput = String(form.get("doco_slug") ?? "").trim().toLowerCase();
    if (!docoSlugInput) {
      return { error: "Pick a Doco slug — the access URL is bound to one Doco." };
    }
    const slugError = validateDocoSlug(docoSlugInput);
    if (slugError) return { error: slugError };
    try {
      await ensureOwnerPrincipalOnDisk(rootDir(), principal.id);
    } catch (e) {
      return { error: `Failed to mirror owner principal: ${(e as Error).message}` };
    }
    try {
      const created = await createDocoInHost(rootDir(), {
        ownerSlug: principal.username,
        docoSlug: docoSlugInput,
        autoSuffixOnCollision: false,
        visibility: "private",
      });
      await mirrorDocoToPostgres(created.path, created.docoId);
      await reindex(created.path);
      boundDocoId = created.docoId as EntityId<"doco">;
      boundOwnerSlug = principal.username;
      boundDocoSlug = created.docoSlug;
      createdDocoSlug = created.docoSlug;
      createdDocoId = created.docoId;
    } catch (e) {
      return { error: `Failed to create Doco: ${(e as Error).message}` };
    }
  }

  // Issue the session token, bound to the chosen Doco so the access URL
  // `/agent/<token>/...` resolves to it without a separate doco identifier.
  const session = await store.issueSessionToken(
    agentId,
    principal.id as EntityId<"principal">,
    boundDocoId,
  );

  await store.approveCliAuthorization(
    state,
    principal.id as EntityId<"principal">,
    agentId,
    session.token,
    boundOwnerSlug,
    boundDocoSlug,
    boundDocoId,
  );

  return {
    ok: true,
    approved_owner: boundOwnerSlug,
    bound_doco_slug: boundDocoSlug,
    bound_doco_id: boundDocoId,
    created_doco_slug: createdDocoSlug,
    created_doco_id: createdDocoId,
  };
}

export function meta() {
  return [{ title: "Authorize agent · Doco" }];
}

export default function CliAuthorize({
  loaderData,
}: {
  loaderData: LoaderOk | LoaderError;
}) {
  const actionData = useActionData<ActionResult>();

  if ("error" in loaderData) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>{errorTitle(loaderData)}</CardTitle>
            <CardDescription>{errorDescription(loaderData)}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <Link to="/" className="text-primary hover:underline">
              Return to the host home
            </Link>
            .
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (actionData && "ok" in actionData) {
    const docoUrl = `${actionData.approved_owner}/${actionData.bound_doco_slug}`;
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>Agent authorized</CardTitle>
            <CardDescription>
              The agent has picked up its access URL. You can close this tab.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Authorized as <strong>{actionData.approved_owner}</strong>.
            </p>
            <p>
              Access URL is bound to{" "}
              <Link
                to={`/${docoUrl}`}
                className="text-primary hover:underline"
              >
                {docoUrl}
              </Link>
              .
            </p>
            {actionData.created_doco_slug ? (
              <p className="text-xs">
                (Created just now as part of this authorization.)
              </p>
            ) : null}
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const cli = loaderData.cli;
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Authorize an agent</CardTitle>
          <CardDescription>
            An agent on your machine is asking for access to a Doco on your account. Review the
            details below and authorize, or deny if you didn&apos;t initiate this.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-border bg-card p-4 text-sm space-y-2">
            <Row label="Agent">
              {cli.cli_user_agent && cli.cli_user_agent !== "unknown" ? (
                <span>{cli.cli_user_agent}</span>
              ) : (
                <span className="text-muted-foreground">unknown</span>
              )}
            </Row>
            <Row label="Hostname">{cli.cli_hostname}</Row>
            <Row label="IP">{cli.client_ip}</Row>
            <Row label="Initiated">{new Date(cli.created_at).toLocaleString()}</Row>
            <Row label="Expires">{new Date(cli.expires_at).toLocaleString()}</Row>
            <Row label="Short code">
              <code className="rounded bg-input px-1 py-0.5 font-mono text-xs">{cli.short_code}</code>
            </Row>
          </div>

          <p className="text-sm text-muted-foreground">
            Signed in as <strong>{loaderData.principal.username}</strong>.
          </p>

          {actionData && "error" in actionData ? (
            <p className="text-sm text-destructive">{actionData.error}</p>
          ) : null}

          <div className="space-y-4">
            {loaderData.myDocos.length > 0 ? (
              <Form method="post" className="space-y-2 rounded-md border border-border bg-card p-4">
                <input type="hidden" name="state" value={loaderData.state} />
                <input type="hidden" name="mode" value="existing" />
                <p className="text-sm font-semibold">Use an existing Doco</p>
                <p className="text-xs text-muted-foreground">
                  Bind this agent's access URL to a Doco you already own.
                </p>
                <div className="space-y-1 text-sm">
                  {loaderData.myDocos.map((d, idx) => (
                    <label key={d.docoId} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="existing_doco_id"
                        value={d.docoId}
                        defaultChecked={idx === 0}
                      />
                      <span className="font-mono">
                        {d.ownerSlug}/{d.docoSlug}
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  type="submit"
                  name="intent"
                  value="approve"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Use this Doco &amp; authorize agent
                </button>
              </Form>
            ) : null}

            <Form method="post" className="space-y-2 rounded-md border border-border bg-card p-4">
              <input type="hidden" name="state" value={loaderData.state} />
              <input type="hidden" name="mode" value="create" />
              <p className="text-sm font-semibold">
                {loaderData.myDocos.length > 0 ? "Or create a new Doco" : "Create a new Doco"}
              </p>
              <p className="text-xs text-muted-foreground">
                The access URL will be bound to the new Doco.
              </p>
              <label className="block text-sm">
                <input
                  type="text"
                  name="doco_slug"
                  placeholder="my-project"
                  pattern="[a-z0-9-]+"
                  className="mt-1 block w-full rounded-md border border-border bg-input px-2 py-1 text-sm font-mono"
                />
                <span className="text-xs text-muted-foreground">
                  Lower-case, kebab-case. Will be created at{" "}
                  <code>{loaderData.principal.username}/&lt;slug&gt;</code>.
                </span>
              </label>
              <button
                type="submit"
                name="intent"
                value="approve"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Create Doco &amp; authorize agent
              </button>
            </Form>

            <Form method="post">
              <input type="hidden" name="state" value={loaderData.state} />
              <button
                type="submit"
                name="intent"
                value="deny"
                className="rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-card"
              >
                Deny
              </button>
            </Form>
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="break-all">{children}</span>
    </div>
  );
}

function errorTitle(err: LoaderError): string {
  if (err.error === "missing_state") return "Missing authorization state";
  if (err.error === "not_found") return "Authorization request not found";
  if (err.error === "expired") return "Authorization request expired";
  if (err.status === "approved" || err.status === "exchanged")
    return "Already authorized";
  return "Already denied";
}

function errorDescription(err: LoaderError): string {
  if (err.error === "missing_state")
    return "This URL is missing the authorization state — ask your agent to restart the connect flow.";
  if (err.error === "not_found")
    return "This authorization request doesn't exist. Ask your agent to restart the connect flow.";
  if (err.error === "expired")
    return "This request timed out. Ask your agent to restart the connect flow.";
  if (err.status === "approved" || err.status === "exchanged")
    return "This request was already authorized. You can close this tab.";
  return "This request was denied. Ask your agent to restart the connect flow if you want to retry.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-6 py-12 w-full">{children}</main>
    </div>
  );
}
