import { useState } from "react";
import { redirect, useFetcher } from "react-router";
import type { EntityId } from "@doco/shared";
import { rootDir } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";
import { getPublicBaseUrl } from "@doco/shared";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({ request }: { request: Request }) {
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const store = TokenStore.forDoco(rootDir());
  const open = await store.listOpenInvitations();
  return { me, host: loadHostConfig(), open };
}

export async function action({ request }: { request: Request }) {
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const store = TokenStore.forDoco(rootDir());
  const inv = await store.issueInvitationToken(me.id as EntityId<"principal">);
  const fullUrl = `${getPublicBaseUrl(request)}/invite/${inv.token}`;
  return { token: inv.token, url: fullUrl, expires_at: inv.expires_at };
}

export function meta() {
  return [{ title: "Invite an agent · Doco" }];
}

export default function Invite({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, host, open } = loaderData;
  const fetcher = useFetcher<{ token: string; url: string; expires_at: string }>();
  const issued = fetcher.data;
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div>
      <SiteHeader context={host.name} mode="host" me={me} />
      <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Invite an agent</CardTitle>
            <CardDescription>
              Generates a 5-minute, single-use URL the agent visits to register itself. Per ADR-037
              + ADR-068.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <fetcher.Form method="post">
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {fetcher.state === "submitting" ? "Generating…" : "Generate invitation"}
              </button>
            </fetcher.Form>
            {issued ? (() => {
              // Short share message — just enough context for a cold-receiving
              // agent to know what the URL is. The page itself handles the
              // explanation; the message doesn't have to. Per ADR-070.
              const shareMessage = `You're invited to register as my agent on Doco. Visit to accept — single-use, expires in 5 min:

${issued.url}`;
              return (
                <div className="mt-4 space-y-2 rounded-md border border-success bg-input p-3">
                  <p className="text-xs text-muted-foreground">
                    Send this to the agent you want to invite.
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-md bg-card px-2 py-2 text-[11px] whitespace-pre-wrap break-words">
{shareMessage}
                  </pre>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(shareMessage);
                      setCopied(issued.token);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
                  >
                    {copied === issued.token ? "Copied!" : "Copy share message"}
                  </button>
                  <p className="text-[11px] text-muted-foreground">
                    Expires {issued.expires_at}. Single-use.
                  </p>
                </div>
              );
            })() : null}
          </CardContent>
        </Card>

        {open.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Open invitations ({open.length})</CardTitle>
              <CardDescription>Not yet redeemed, not expired.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs">
                {open.map((t) => (
                  <li key={t.token} className="font-mono">
                    <code className="rounded bg-input px-2 py-0.5">{t.token.slice(0, 12)}…</code>{" "}
                    <span className="text-muted-foreground">expires {t.expires_at}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Agent-side recipe</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border border-border bg-input p-3 text-[11px]">
{`# Once the human shares the URL, the agent extracts the token and:

curl -X POST \\
     -H "Authorization: Bearer <invitation-token>" \\
     -H "content-type: application/json" \\
     -d '{"display_name":"my-agent","model":"claude-opus-4-7","provider":"anthropic"}' \\
     http://127.0.0.1:8787/api/v1/invitations/redeem

# Response:
# { "session_token": "<long-lived>", "principal": { "id": "principal_...", ... } }

# Store the session token; spawn child agents:
export DOCO_TOKEN=<long-lived>
curl -X POST -H "Authorization: Bearer $DOCO_TOKEN" \\
     http://127.0.0.1:8787/api/v1/agents/spawn \\
     -d '{"display_name":"child agent"}'`}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
