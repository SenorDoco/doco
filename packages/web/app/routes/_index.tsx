import { getPublicBaseUrl } from "@doco/shared";
import { Link } from "react-router";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { agentInstructions } from "~/lib/agent-instructions";
import { getCurrentPrincipal } from "~/lib/session.server";
import { TAGLINE } from "~/lib/tagline";

/**
 * Host home — the same page whether or not the visitor is signed in: what
 * Doco is, and the instructions to give an agent, with a Copy button. Agents
 * read this page too; it is their entry point, and the copy they keep in
 * AGENTS.md is checked against it.
 */
export async function loader({ request }: { request: Request }) {
  let signedIn = false;
  try {
    signedIn = Boolean(await getCurrentPrincipal(request));
  } catch (error) {
    console.warn("Home session lookup failed; rendering signed-out header.", error);
  }
  return { signedIn, instructions: agentInstructions(getPublicBaseUrl(request)) };
}

export function meta() {
  return [
    { title: `Doco · ${TAGLINE}` },
    {
      name: "description",
      content: `${TAGLINE}. The instructions to give an agent are on this page.`,
    },
  ];
}

export default function Home({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { signedIn, instructions } = loaderData;
  return (
    <div className="flex min-h-screen flex-col">
      {/* Signed in, the app shell's header already carries the mark and the
          nav; this header is only for signed-out visitors. */}
      {signedIn ? null : (
        <header className="neu-header border-b border-border bg-card">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
            <div className="flex min-w-0 items-center gap-3 overflow-hidden">
              <Link
                to="/"
                className="inline-flex items-center hover:opacity-80"
                aria-label="Doco home"
              >
                <DocoMark height={28} />
              </Link>
              <VersionPill />
            </div>
            <Link
              to="/sign-in"
              className="neu-button shrink-0 whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
            >
              Sign in
            </Link>
          </div>
        </header>
      )}

      <main className="flex-1 px-6 py-12 md:py-16">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="sr-only">Doco</h1>
            <DocoMark height={72} />
            <p className="text-2xl font-bold leading-tight md:text-4xl">{TAGLINE}</p>
          </div>

          <AgentInstructionsBlock
            title="To use Doco with your agent(s), give them these instructions:"
            instructions={instructions}
          />
        </div>
      </main>
    </div>
  );
}
