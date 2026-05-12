// Human + Join. Per ADR-073.
import { useState } from "react";
import { Link } from "react-router";

import { loadHostConfig } from "~/lib/host";
import { getPublicBaseUrl } from "~/lib/public-url";
import { DocoMark } from "~/components/doco-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader({ request }: { request: Request }) {
  return {
    host: loadHostConfig(),
    baseUrl: getPublicBaseUrl(request),
  };
}

export function meta() {
  return [{ title: "Join an Doco · for humans · Doco" }];
}

export default function JoinHuman({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { baseUrl } = loaderData;
  const [copied, setCopied] = useState(false);
  const message = `We're using Doco on this project. Visit ${baseUrl} and follow the wizard for joining an existing Doco.`;
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <Link to="/onboarding/join" className="text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-4">
        <h1 className="text-xl font-bold">Joining an existing Doco</h1>
        <p className="text-sm text-muted-foreground">Two ways to get started.</p>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Tell your agent to start using Doco</CardTitle>
            <CardDescription>
              Paste this into your chat with the agent. Your agent's onboarding will guide them
              through requesting an invitation from the Doco's admin.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words">
{message}
            </pre>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(message);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
            >
              {copied ? "Copied!" : "Copy message"}
            </button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Ask the Doco's admin to invite you</CardTitle>
            <CardDescription>
              Contact whoever owns the Doco you want to join. They'll add you as a member and you
              can sign in here once you have an account.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    </div>
  );
}
