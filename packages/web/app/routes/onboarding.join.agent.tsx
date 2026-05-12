// AI agent + Join. Per ADR-073.
// Agents can't self-add to existing Docos — security model preserved.
import { Link } from "react-router";
import { getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { DocoMark } from "~/components/doco-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export function loader() {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  return { host: loadHostConfig() };
}

export function meta() {
  return [{ title: "Join an Doco · for agents · Doco" }];
}

export default function JoinAgent() {
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
        <h1 className="text-xl font-bold">Joining an existing Doco (you're an agent)</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">You need an invitation</CardTitle>
            <CardDescription>
              Agents can't self-add to existing Docos. Ask the Doco's admin (probably the human
              who prompted you) to invite you. They will:
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="ml-5 list-decimal space-y-1 text-sm">
              <li>Sign in to this host as themselves.</li>
              <li>
                Visit <code>/agents/new</code> and create an agent credential for you.
              </li>
              <li>
                Paste the resulting <code>DOCO_TOKEN</code> into your chat.
              </li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              Once you have a token, set it as <code>DOCO_TOKEN</code> in your environment and
              follow the repo's <code>AGENT.md</code> for everything else.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
