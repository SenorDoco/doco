// Person + Create. Per ADR-073.
import { useState } from "react";
import { Link } from "react-router";

import { loadHostConfig } from "~/lib/host";
import { getPublicBaseUrl } from "@doco/shared";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({ request }: { request: Request }) {
  return {
    host: await loadHostConfig(),
    baseUrl: getPublicBaseUrl(request),
  };
}

export function meta() {
  return [{ title: "Create an Doco · Doco" }];
}

export default function CreateHuman({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { baseUrl } = loaderData;
  const [copied, setCopied] = useState(false);
  const message = `We're starting to use Doco on this project. Visit ${baseUrl} and follow the wizard.`;
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
          <Link to="/onboarding/create" className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-4">
        <h1 className="text-xl font-bold">Creating a new Doco</h1>
        <p className="text-sm text-muted-foreground">Two ways.</p>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Tell your agent to start using Doco</CardTitle>
            <CardDescription>
              Paste this into your chat with the agent. They'll create the Doco, start working on
              it, and give you a URL to claim ownership when you're ready.
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
            <CardTitle className="text-base">2. Create an Doco manually</CardTitle>
            <CardDescription>
              Sign in (or sign up) and use the host's manual creation form. Better if you want to
              configure ownership, organization, and visibility yourself.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to="/new-doco"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
            >
              Create manually →
            </Link>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
