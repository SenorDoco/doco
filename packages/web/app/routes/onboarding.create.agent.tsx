// /onboarding/create/agent — info-only page for agents arriving via the
// web. The HTTP-POST "agent creates an unclaimed Doco" form is retired
// (decision_01KRKZM14WNA1685GN0F12WCKM). Tell the agent to run
// `doco login --create <slug>` from the project root instead.
//
// An agent that lands here is one of two cases:
//   1. Following AGENTS.md in a repo that hasn't been updated yet, so
//      it still has the old "visit /onboarding/create/agent" pointer.
//   2. Walking the host root because the project owner told it to "set
//      up a Doco for this project" with no other context.
//
// Either way the answer is the same: run `doco login --create <slug>`.
import { Link } from "react-router";
import { loadHostConfig } from "~/lib/host";
import { getPublicBaseUrl } from "@doco/shared";
import { DocoMark } from "~/components/doco-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({ request }: { request: Request }) {
  return {
    host: await loadHostConfig(),
    baseUrl: getPublicBaseUrl(request),
  };
}

export function meta() {
  return [{ title: "Create a Doco · for agents · Doco" }];
}

export function links() {
  return [
    { rel: "alternate", type: "text/plain", href: "/onboarding/create/agent.txt" },
  ];
}

export default function CreateAgent({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const cmd = `doco login --host ${loaderData.baseUrl} --create <slug>`;
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-4 w-full">
        <Card>
          <CardHeader>
            <CardTitle>Run <code>doco login --create</code> from your project root</CardTitle>
            <CardDescription>
              The browser-side "create a Doco as an agent" form is retired. Create a Doco from
              the CLI instead — the project owner authorizes the session in a browser tab,
              then this CLI writes <code>./.env</code> for you and the Doco is created
              directly under their account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <pre className="rounded-md bg-input p-3 text-xs font-mono overflow-x-auto">{cmd}</pre>

            <p>What happens, step by step:</p>
            <ol className="list-decimal pl-5 space-y-1.5 text-foreground">
              <li>The CLI opens this host's <code>/cli/authorize</code> in the project owner's default browser.</li>
              <li>They sign in (if they aren't already) and review a one-screen identity card: CLI version, hostname, IP, timestamp, short code.</li>
              <li>They click <strong>Authorize</strong>. The server creates an agent Principal owned by them, mints a session token, and creates the Doco at <code>{loaderData.baseUrl}/&lt;their-username&gt;/&lt;slug&gt;</code>.</li>
              <li>The CLI captures the token via polling and writes <code>DOCO_HOST</code> / <code>DOCO_TOKEN</code> / <code>DOCO_SLUG</code> to <code>./.env</code>.</li>
              <li>Restart your agent session to pick up the new credentials. The bootstrap hooks in <code>AGENTS.md</code> handle everything from there.</li>
            </ol>

            <p className="pt-2">
              If <code>doco</code> isn't on PATH, install the CLI first:{" "}
              <code className="rounded bg-input px-1 py-0.5 font-mono">npm i -g @doco/cli</code>{" "}
              (or invoke ad-hoc with <code className="rounded bg-input px-1 py-0.5 font-mono">npx @doco/cli</code>).
            </p>

            <p>
              If the project owner <em>denies</em> the prompt, the CLI exits non-zero and nothing
              is written. Don't retry on a loop — stop and ask what they want to do.
            </p>

            <p className="text-xs text-muted-foreground pt-2">
              See the <Link to="/onboarding/create/agent.txt" className="text-primary hover:underline">plain-text version</Link>{" "}
              if you're an agent reading via the AGENTS.md convention. To create as a human via
              a form, see <Link to="/onboarding/create/human" className="text-primary hover:underline">the human onboarding flow</Link>.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
