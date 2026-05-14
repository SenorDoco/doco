// AI agent + Create. Per ADR-073.
//
// Self-serve Doco creation without auth. Creates an UNCLAIMED Doco whose
// owner is the host-bootstrap placeholder Principal, plus a bootstrap-owned
// agent Principal, plus a session token (DOCO_TOKEN) for the agent to use
// immediately, plus a claim_token URL for the owner to take ownership later.
//
// Business logic for the form post lives in
// `~/lib/onboarding-create-agent.server` (so it stays server-only when this
// route is bundled for the client).
import { useState } from "react";
import { Form, Link, useActionData } from "react-router";
import { loadHostConfig } from "~/lib/host";
import { createDocoAsAgentFromForm } from "~/lib/onboarding-create-agent.server";
import { getPublicBaseUrl } from "@doco/shared";

const BOOTSTRAP_USERNAME_LABEL = "host-bootstrap";
import { DocoMark } from "~/components/doco-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({ request }: { request: Request }) {
  return {
    host: await loadHostConfig(),
    baseUrl: getPublicBaseUrl(request),
  };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const baseUrl = getPublicBaseUrl(request);
  return createDocoAsAgentFromForm({ form, baseUrl });
}

export function meta() {
  return [{ title: "Create an Doco · for agents · Doco" }];
}

export function links() {
  return [
    { rel: "alternate", type: "text/plain", href: "/onboarding/create/agent.txt" },
    { rel: "alternate", type: "application/json", href: "/onboarding/create/agent.json" },
  ];
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
            Unclaimed for now. You can start working immediately. The owner you're collaborating
            with should claim it using the URL below.
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
              <CardTitle className="text-base">Claim message for the owner</CardTitle>
              <CardDescription>
                Paste this into your chat with the owner who prompted you. They visit the URL,
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
            <CardContent className="space-y-3">
              <div className="rounded-md border border-border bg-card/50 p-3 text-xs">
                <p className="mb-2 font-semibold text-foreground">
                  What to add first
                </p>
                <p className="mb-2 text-muted-foreground">
                  A solid starter set is{" "}
                  <code className="font-mono text-foreground">adrs</code>{" "}
                  (architectural choices),{" "}
                  <code className="font-mono text-foreground">user-flows</code>{" "}
                  (end-to-end journeys), plus{" "}
                  <strong>1–2 custom scopes</strong> named for{" "}
                  <em>this project&apos;s</em> actual subject areas (e.g.{" "}
                  <code className="font-mono text-foreground">payments</code>,{" "}
                  <code className="font-mono text-foreground">search</code>,{" "}
                  <code className="font-mono text-foreground">content-schema</code>).
                  More templates exist (apis, bugs, runbooks, post-mortems,
                  glossary, roadmap) but adding them when the need arises beats
                  adding them all up front.
                </p>
                <p className="font-semibold text-foreground">
                  What &ldquo;watched&rdquo; means
                </p>
                <p className="text-muted-foreground">
                  Each scope carries a <strong>watched</strong> flag — a soft
                  attention signal. Watched means: when you (or an agent)
                  capture work later, this scope nudges you to consider whether
                  the work belongs here. It&apos;s a prompt, not a rule —
                  nothing blocks a capture that omits a watched scope.{" "}
                  <strong>
                    Scopes you add during onboarding default to watched
                  </strong>{" "}
                  because you&apos;re picking them on purpose right now. You
                  can flip any scope&apos;s watched value any time from the
                  scope&apos;s edit page.
                </p>
              </div>
              <Link
                to={`/${BOOTSTRAP_USERNAME_LABEL}/${ok.doco_slug}/scopes/new?onboarding=1`}
                className="inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
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
              owner you're collaborating with claims it. You can write to it in full immediately.
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
        <p className="text-center text-[11px] text-muted-foreground">
          Agent? You probably want the plain-text version of this page:{" "}
          <a href="/onboarding/create/agent.txt" className="text-primary hover:underline">
            /onboarding/create/agent.txt
          </a>
        </p>
      </main>
    </div>
  );
}
