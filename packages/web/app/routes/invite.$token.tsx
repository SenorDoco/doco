import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { rootDir, getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { TokenStore } from "~/lib/tokens.server";
import { redeemInvitation, findPrincipalById } from "~/lib/redeem.server";
import { getPublicBaseUrl } from "~/lib/public-url";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

// ────────────────────────────────────────────────────────────────────────────
// Self-describing agent-side redemption page.
//
// An agent who receives the invitation URL out-of-band (or pasted into a
// different Claude session) needs to know:
//   1. *what* this URL is — an Doco agent invitation
//   2. *who* invited them — to gauge trust + relationship
//   3. *how* to redeem — exact API call, all fields filled in
//   4. *why* they might decline — one-time, single-use, owner_id binding
//
// We solve (1)–(4) by content negotiation:
//   GET /invite/<token>           Accept: text/html       → readable page
//   GET /invite/<token>           Accept: application/json → manifest JSON
//   POST /invite/<token>          (form or JSON body)     → redeem
// ────────────────────────────────────────────────────────────────────────────

interface InvitationManifest {
  kind: "doco_invitation";
  schema_version: "0.1";
  status: "open" | "expired" | "used" | "unknown_token";
  host: { name: string; url: string };
  inviter?: { id: string; username: string; type: "human" | "agent" };
  token: string;
  expires_at?: string;
  redeem?: {
    method: "POST";
    url: string;
    headers: Record<string, string>;
    body_schema: Record<string, string>;
    example_body: Record<string, unknown>;
  };
  notes: string[];
}

export async function loader({ request, params }: { request: Request; params: { token: string } }) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const root = rootDir();
  const host = loadHostConfig();
  const store = TokenStore.forDoco(root);
  const inv = await store.resolveInvitation(params.token);
  const baseUrl = getPublicBaseUrl(request);

  let manifest: InvitationManifest;
  if (!inv) {
    manifest = {
      kind: "doco_invitation",
      schema_version: "0.1",
      status: "unknown_token",
      host: { name: host.name, url: baseUrl },
      token: params.token,
      notes: [
        "This invitation token is not valid. It may have been already redeemed (single-use), expired (5-minute TTL), or never existed.",
        "If you received this URL out-of-band, ask the inviter for a fresh one.",
      ],
    };
  } else {
    const inviter = findPrincipalById(root, inv.inviter_id);
    manifest = {
      kind: "doco_invitation",
      schema_version: "0.1",
      status: "open",
      host: { name: host.name, url: baseUrl },
      inviter: inviter
        ? { id: inviter.id, username: inviter.username, type: inviter.type }
        : undefined,
      token: params.token,
      expires_at: inv.expires_at,
      redeem: {
        method: "POST",
        url: `${baseUrl}/invite/${params.token}.json`,
        headers: { "content-type": "application/json" },
        body_schema: {
          display_name: "string (required) — human-friendly name for this agent",
          model: "string (recommended) — e.g. claude-opus-4-7, gpt-4o, etc.",
          provider: "string (recommended) — e.g. anthropic, openai",
          capabilities: "string[] (optional) — declared capabilities/tools",
        },
        example_body: {
          display_name: "my-agent",
          model: "claude-opus-4-7",
          provider: "anthropic",
        },
      },
      notes: [
        "This is a single-use, 5-minute Doco invitation token. Per ADR-037 + ADR-068.",
        `Redeeming creates a Principal{type: agent} owned by ${inviter?.username ?? "the inviter"} on this host.`,
        "The response includes a long-lived session token — store it as DOCO_TOKEN to spawn child agents later.",
        "If you were not expecting this invitation or do not wish to register, simply do not redeem. The token will expire in 5 minutes.",
      ],
    };
  }

  return { manifest, host };
}

export async function action({ request, params }: { request: Request; params: { token: string } }) {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  const ct = request.headers.get("content-type") ?? "";
  let body: { display_name?: string; model?: string; provider?: string; capabilities?: string[] };
  if (ct.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as typeof body;
  } else {
    const form = await request.formData();
    body = {
      display_name: String(form.get("display_name") ?? "") || undefined,
      model: String(form.get("model") ?? "") || undefined,
      provider: String(form.get("provider") ?? "") || undefined,
    };
  }

  const result = await redeemInvitation(rootDir(), params.token, body);
  if ("error" in result) {
    const status =
      result.error.kind === "invalid_or_expired_invitation"
        ? 401
        : result.error.kind === "inviter_no_longer_exists"
          ? 410
          : 500;
    if (ct.includes("application/json") || (request.headers.get("accept") ?? "").includes("application/json")) {
      throw new Response(JSON.stringify({ error: result.error }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return { error: result.error };
  }

  if (ct.includes("application/json") || (request.headers.get("accept") ?? "").includes("application/json")) {
    throw new Response(JSON.stringify(result, null, 2), {
      status: 201,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return { ok: result };
}

export function meta({ data }: { data: { manifest: InvitationManifest; host: { name: string } } | undefined }) {
  if (!data) return [{ title: "Invitation · Doco" }];
  return [{ title: `Agent invitation · ${data.host.name} · Doco` }];
}

export default function InviteRedeem() {
  const { manifest, host } =
    useLoaderData<{ manifest: InvitationManifest; host: { name: string } }>();
  const actionData = useActionData<
    | {
        ok: {
          session_token: string;
          principal: {
            id: string;
            username: string;
            display_name: string;
            type: "agent";
            owner_id: string;
          };
        };
      }
    | { error: { kind: string; detail?: string } }
  >();
  const [copied, setCopied] = useState<string | null>(null);

  // JSON-LD manifest embedded in every render — agents fetching this URL
  // (any Accept header) can extract this <script> block to learn what this
  // page is and how to redeem. See ADR-069.
  const jsonLd = (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(manifest, null, 2) }}
    />
  );

  // ORDER MATTERS: a successful redemption marks the invitation used, so on
  // the post-action revalidation the loader sees the token as consumed and
  // would render the "unknown_token" state. Check actionData FIRST.
  if (actionData && "ok" in actionData) {
    const { session_token, principal } = actionData.ok;
    return (
      <div>
        {jsonLd}
        <SiteHeader context={host.name} mode="host" me={null} />
        <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Welcome — registered as agent</CardTitle>
              <CardDescription>
                You are now Principal {principal.username} (id <code>{principal.id}</code>) on
                this host, owned by Principal <code>{principal.owner_id}</code>. Save the session
                token below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 rounded-md border border-success bg-input p-3">
                <p className="text-xs text-muted-foreground">
                  Long-lived session token — store as <code>DOCO_TOKEN</code>. Do not share.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md bg-card px-2 py-1 text-xs">
                    {session_token}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(session_token);
                      setCopied(session_token);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-card"
                  >
                    {copied === session_token ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                With this token you can spawn child agents:
              </p>
              <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-input p-3 text-[11px]">
                {`export DOCO_TOKEN=${session_token}
curl -X POST -H "Authorization: Bearer $DOCO_TOKEN" \\
     -H "content-type: application/json" \\
     -d '{"display_name":"child agent"}' \\
     ${manifest.host.url}/api/v1/agents/spawn`}
              </pre>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  if (manifest.status === "unknown_token") {
    return (
      <div>
        {jsonLd}
        <SiteHeader context={host.name} mode="host" me={null} />
        <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Invitation not valid</CardTitle>
              <CardDescription>
                This invitation token is unknown, already redeemed, or expired. Ask the inviter
                for a fresh URL.
              </CardDescription>
            </CardHeader>
          </Card>
        </main>
      </div>
    );
  }

  // Default GET: self-describing page. The curl example points at the .json
  // resource route so the response is JSON.
  const curlExample = `curl -X POST -H "content-type: application/json" \\
     -d '${JSON.stringify(manifest.redeem!.example_body)}' \\
     ${manifest.redeem!.url}

# Or fetch the manifest as JSON:
curl ${manifest.redeem!.url.replace(/\\.json$/, ".json")}`;

  return (
    <div>
      {jsonLd}
      <SiteHeader context={host.name} mode="host" me={null} />
      <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Agent invitation · {host.name}</CardTitle>
            <CardDescription>
              You've been invited to register as an agent on this Doco host
              {manifest.inviter ? ` by ${manifest.inviter.username}` : ""}. Single-use, expires{" "}
              {manifest.expires_at}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">What this is</p>
              <p>
                A 5-minute, single-use invitation token to self-register as a non-human Principal
                (type: agent) on {host.name}. Per ADR-037 + ADR-068 of Doco's alignment framework.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                What happens when you redeem
              </p>
              <ul className="ml-5 list-disc text-xs">
                <li>
                  A new <code>Principal{`{type: agent}`}</code> is created with{" "}
                  <code>owner_id = {manifest.inviter?.id ?? "<inviter>"}</code>.
                </li>
                <li>
                  This token is marked single-used; subsequent redemptions return{" "}
                  <code>invalid_or_expired_invitation</code>.
                </li>
                <li>
                  You receive a long-lived <code>session_token</code>. Store it. Use it to spawn
                  child agents (chain remains traceable to a human).
                </li>
                <li>
                  Only humans on this host can delete Docos. Agents cannot — by design (see
                  rule_only_humans_delete_doco).
                </li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                Don't recognize this URL?
              </p>
              <p className="text-xs">
                If you received this token unexpectedly, simply ignore it. It expires in 5 minutes
                and never grants access until redeemed.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Redeem (browser)</CardTitle>
            <CardDescription>For humans clicking through, or agents driving a browser.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="text-muted-foreground">display_name *</span>
                <input
                  required
                  name="display_name"
                  defaultValue="my-agent"
                  className="mt-1 w-full rounded-md border border-border bg-input px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="text-muted-foreground">model</span>
                <input
                  name="model"
                  defaultValue="claude-opus-4-7"
                  className="mt-1 w-full rounded-md border border-border bg-input px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="text-muted-foreground">provider</span>
                <input
                  name="provider"
                  defaultValue="anthropic"
                  className="mt-1 w-full rounded-md border border-border bg-input px-2 py-1 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Register as agent
              </button>
            </Form>
            {actionData && "error" in actionData ? (
              <p className="mt-2 text-xs text-destructive">{actionData.error.kind}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Redeem (curl)</CardTitle>
            <CardDescription>For headless agents.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border border-border bg-input p-3 text-[11px]">
              {curlExample}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              Or fetch this same page with <code>Accept: application/json</code> for a
              machine-readable manifest.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
