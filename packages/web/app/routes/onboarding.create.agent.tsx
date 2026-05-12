// AI agent + Create. Per ADR-073.
//
// Self-serve Doco creation without auth. Creates an UNCLAIMED Doco whose
// owner is the host-bootstrap placeholder Principal, plus a bootstrap-owned
// agent Principal, plus a session token (DOCO_TOKEN) for the agent to use
// immediately, plus a claim_token URL for the human to take ownership later.
import { useState } from "react";
import { Form, Link, useActionData } from "react-router";
import type { EntityId } from "@doco/shared";
import { rootDir } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { TokenStore } from "~/lib/tokens.server";
import { addAgentPrincipal, createDocoInHost, reindex } from "~/lib/redeem.server";
import { getOrCreateHostBootstrap, HOST_BOOTSTRAP_USERNAME } from "~/lib/bootstrap.server";
import { getPublicBaseUrl } from "@doco/shared";

// Repeat the constant so the component (non-server) can reference it without
// pulling the .server module into the client bundle.
const BOOTSTRAP_USERNAME_LABEL = "host-bootstrap";
import { DocoMark } from "~/components/doco-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader({ request }: { request: Request }) {
  return {
    host: loadHostConfig(),
    baseUrl: getPublicBaseUrl(request),
  };
}

export async function action({ request }: { request: Request }) {
  const root = rootDir();
  const baseUrl = getPublicBaseUrl(request);

  const form = await request.formData();
  const docoSlug = String(form.get("doco_slug") ?? "").trim().toLowerCase();
  const description = String(form.get("description") ?? "").trim();
  const visibility = (String(form.get("visibility") ?? "private") as "private" | "public");
  const agentDisplayName = String(form.get("agent_display_name") ?? "").trim() || "my-agent";
  const model = String(form.get("model") ?? "").trim() || "unknown";
  const provider = String(form.get("provider") ?? "").trim() || "unknown";

  if (!docoSlug || !/^[a-z0-9_-]+$/.test(docoSlug)) {
    return { error: "Doco slug is required and must be lowercase kebab-case." };
  }

  // 1. Ensure host-bootstrap placeholder Principal exists.
  const bootstrap = getOrCreateHostBootstrap(root);

  // 2. Create the unclaimed Doco, owned by host-bootstrap.
  let docoRec: { docoId: string; path: string };
  try {
    const created = await createDocoInHost(root, {
      ownerSlug: HOST_BOOTSTRAP_USERNAME,
      docoSlug,
      ...(description ? { description } : {}),
      visibility,
    });
    docoRec = { docoId: created.docoId, path: created.path };
  } catch (e) {
    return { error: `Failed to create Doco: ${(e as Error).message}` };
  }
  await reindex(docoRec.path);

  // 3. Create the bootstrap-owned agent Principal.
  const isoNow = new Date().toISOString();
  const agentUsername = `${HOST_BOOTSTRAP_USERNAME}/${isoNow}`;
  let agentId: EntityId<"principal">;
  try {
    agentId = await addAgentPrincipal(root, {
      username: agentUsername,
      display_name: agentDisplayName,
      owner_id: bootstrap.id,
      agent_metadata: {
        provider,
        model,
        capabilities: [],
        created_at: isoNow,
      },
    });
  } catch (e) {
    return { error: `Failed to create agent Principal: ${(e as Error).message}` };
  }

  // 4. Issue an DOCO_TOKEN for the agent.
  const store = TokenStore.forDoco(root);
  const session = await store.issueSessionToken(agentId, bootstrap.id);

  // 5. Issue a claim token bound to (Doco, bootstrap-agent).
  const claim = await store.issueClaimToken(docoRec.docoId, agentId);

  return {
    ok: {
      doco_url: `${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/${docoSlug}`,
      doco_slug: docoSlug,
      session_token: session.token,
      claim_url: `${baseUrl}/claim/${claim.token}`,
      claim_expires_at: claim.expires_at,
      principal: {
        id: agentId,
        username: agentUsername,
        display_name: agentDisplayName,
      },
    },
  };
}

export function meta() {
  return [{ title: "Create an Doco · for agents · Doco" }];
}

export default function CreateAgent({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const actionData = useActionData<
    | {
        ok: {
          doco_url: string;
          doco_slug: string;
          session_token: string;
          claim_url: string;
          claim_expires_at: string;
          principal: { id: string; username: string; display_name: string };
        };
      }
    | { error: string }
  >();
  const [copied, setCopied] = useState<string | null>(null);

  if (actionData && "ok" in actionData) {
    const { ok } = actionData;
    const claimMessage = `I've started a new Doco for our project. To take ownership, visit ${ok.claim_url} (expires ${ok.claim_expires_at}). Sign in or sign up there and click Claim.`;
    return (
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
            <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
              <DocoMark height={28} />
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-6 py-12 space-y-4">
          <h1 className="text-xl font-bold">Doco created · {ok.doco_slug}</h1>
          <p className="text-sm text-muted-foreground">
            Unclaimed for now. You can start working immediately. The human you're collaborating
            with should claim ownership using the URL below.
          </p>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">DOCO_TOKEN</CardTitle>
              <CardDescription>
                Set this in your environment. We won&apos;t show it again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-card px-2 py-1 text-xs">
                  {ok.session_token}
                </code>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(ok.session_token);
                    setCopied("token");
                    setTimeout(() => setCopied(null), 1500);
                  }}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-card"
                >
                  {copied === "token" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Doco URL: <a href={ok.doco_url} className="text-primary hover:underline">{ok.doco_url}</a>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Read <code>AGENT.md</code> in the repo for how to authenticate, attribute work,
                and follow the project's conventions.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Claim message for the human</CardTitle>
              <CardDescription>
                Paste this into your chat with the human who prompted you. They visit the URL,
                sign in or sign up, and take ownership of the Doco.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <pre className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words">
{claimMessage}
              </pre>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(claimMessage);
                  setCopied("claim");
                  setTimeout(() => setCopied(null), 1500);
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                {copied === "claim" ? "Copied!" : "Copy claim message"}
              </button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Next: define scopes</CardTitle>
              <CardDescription>
                Scopes are topical neighborhoods every node belongs to. The Doco
                needs at least one before nodes can be added — but you can take
                care of this any time.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to={`/${BOOTSTRAP_USERNAME_LABEL}/${ok.doco_slug}/scopes/new?onboarding=1`}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Set up scopes →
              </Link>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <Link to="/onboarding/create" className="text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-4">
        <h1 className="text-xl font-bold">Create a new Doco (you're an agent)</h1>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Set up the Doco</CardTitle>
            <CardDescription>
              The Doco will be unclaimed (owned by the host's placeholder Principal) until the
              human you're collaborating with claims it. You can write to it in full immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Doco slug *</span>
                <input
                  required
                  name="doco_slug"
                  pattern="[a-z0-9_-]+"
                  placeholder="my-project"
                  autoFocus
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Lowercase kebab-case. URL becomes /{BOOTSTRAP_USERNAME_LABEL}/&lt;slug&gt; until claimed.
                </span>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Description (optional)</span>
                <textarea
                  name="description"
                  rows={2}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Visibility</span>
                <select
                  name="visibility"
                  defaultValue="private"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground">
                Next step after creation: define the scopes you'll document
                in. Required before nodes can be added; can be done anytime.
              </p>
              <hr className="border-border" />
              <p className="text-xs text-muted-foreground">About you (the agent):</p>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Your display_name</span>
                <input
                  name="agent_display_name"
                  defaultValue="my-agent"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Model</span>
                <input
                  name="model"
                  defaultValue="claude-opus-4-7"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Provider</span>
                <input
                  name="provider"
                  defaultValue="anthropic"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Create Doco + get token
              </button>
            </Form>
            {actionData && "error" in actionData ? (
              <p className="mt-2 text-xs text-destructive">{actionData.error}</p>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
