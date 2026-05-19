import type { EntityId } from "@doco/shared";
// /agents/new — owner creates a Principal{type:agent} + DOCO_ACCESS in one step.
// Per ADR-071. Replaces the invitation-redemption ceremony for agent enrollment.
import { useState } from "react";
import { Form, redirect, useActionData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { loadHostConfig } from "~/lib/host";
import { addAgentPrincipal } from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  return { me, host: await loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");

  const form = await request.formData();
  const model = String(form.get("model") ?? "").trim();
  const provider = String(form.get("provider") ?? "").trim();
  const capsRaw = String(form.get("capabilities") ?? "").trim();
  const capabilities = capsRaw
    ? capsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Username convention per ADR-036: `{owner_username}/{ISO_timestamp}`.
  const isoNow = new Date().toISOString();
  const username = `${me.username}/${isoNow}`;
  const ownerId = me.id as EntityId<"principal">;

  let principalId: EntityId<"principal">;
  try {
    principalId = await addAgentPrincipal(rootDir(), {
      username,
      owner_id: ownerId,
      agent_metadata: {
        provider: provider || "unknown",
        model: model || "unknown",
        capabilities,
        created_at: isoNow,
      },
    });
  } catch (e) {
    return { error: `Failed to create agent: ${(e as Error).message}` };
  }

  const store = TokenStore.forDoco(rootDir());
  const session = await store.issueSessionToken(principalId, ownerId);

  return {
    ok: {
      doco_access: session.token,
      principal: {
        id: principalId,
        username,
        type: "agent" as const,
        owner_id: ownerId,
        model: model || "unknown",
        provider: provider || "unknown",
      },
    },
  };
}

export function meta() {
  return [{ title: "New agent · Doco" }];
}

export default function AgentsNew({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, host } = loaderData;
  const actionData = useActionData<
    | {
        ok: {
          doco_access: string;
          principal: {
            id: string;
            username: string;
            type: "agent";
            owner_id: string;
            model: string;
            provider: string;
          };
        };
      }
    | { error: string }
  >();
  const [copied, setCopied] = useState<string | null>(null);

  if (actionData && "ok" in actionData) {
    const { doco_access, principal } = actionData.ok;
    return (
      <div>
        <SiteHeader mode="host" me={me} />
        <SingleColumnPageMain className="py-8 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent created · {principal.username}</CardTitle>
              <CardDescription>
                Paste this access credential into your chat with the agent. Their repo&apos;s{" "}
                <code>AGENTS.md</code> tells them how to use it. We won&apos;t show it again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 rounded-md border border-success bg-input p-3">
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md bg-card px-2 py-1 text-xs">
                    {doco_access}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(doco_access);
                      setCopied(doco_access);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-card"
                  >
                    {copied === doco_access ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Principal: <code>{principal.id}</code>
              </p>

              <div className="flex gap-2 pt-1">
                <a
                  href="/users"
                  className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-card"
                >
                  ← Back to your users
                </a>
                <a
                  href="/agents/new"
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  Create another
                </a>
              </div>
            </CardContent>
          </Card>
        </SingleColumnPageMain>
      </div>
    );
  }

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>New agent</CardTitle>
            <CardDescription>
              Creates a Principal{"{type: agent}"} owned by you and returns a Doco access
              credential. Pass it to your tooling as <code>DOCO_ACCESS</code>; your agent will use
              it to act on your behalf. Per ADR-071.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="text-muted-foreground">model</span>
                <input
                  name="model"
                  defaultValue="claude-opus-4-7"
                  className="mt-1 w-full rounded-md border border-border bg-input px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="text-muted-foreground">provider</span>
                <input
                  name="provider"
                  defaultValue="anthropic"
                  className="mt-1 w-full rounded-md border border-border bg-input px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="text-muted-foreground">
                  capabilities (comma-separated, optional)
                </span>
                <input
                  name="capabilities"
                  placeholder="code-edit, web-fetch"
                  className="mt-1 w-full rounded-md border border-border bg-input px-2 py-1.5 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Create agent
              </button>
            </Form>
            {actionData && "error" in actionData ? (
              <p className="mt-2 text-xs text-destructive">{actionData.error}</p>
            ) : null}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
