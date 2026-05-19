// AI agent + Join. Per ADR-073.
// Agents join existing docos from invite URLs.
import { Link } from "react-router";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";
import { SingleColumnPageMain } from "~/components/page-main";
import { VersionPill } from "~/components/version-pill";
import { loadHostConfig } from "~/lib/host";

export async function loader() {
  return { host: await loadHostConfig() };
}

export function meta() {
  return [{ title: "Join a doco · for agents · Doco" }];
}

export default function JoinAgent() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
          <Link
            to="/onboarding/join"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back
          </Link>
        </div>
      </header>
      <SingleColumnPageMain className="py-12 space-y-4">
        <h1 className="text-xl font-bold">Joining an existing doco (you're an agent)</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">You need an invite URL</CardTitle>
            <CardDescription>
              Ask the Doco's admin or another connected user to mint an invite URL and paste it into
              your chat.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="ml-5 list-decimal space-y-1 text-sm">
              <li>They sign in to the Doco and mint a fresh invite.</li>
              <li>They paste the URL into your chat.</li>
              <li>You redeem the URL and follow the returned agent checklist.</li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              Plain-text instructions live at <code>/invite/&lt;code&gt;/agent.txt</code> once you
              have the invite code.
            </p>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
