import { Link, redirect } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

const FALLBACK_HOST = { id: "host_fallback", name: "torrenegra", visibility: "public" } as const;

/**
 * Host home — anonymous landing only. Signed-in users are redirected to
 * /dashboard so the marketing copy never gets in the way of their work.
 */
export async function loader({ request }: { request: Request }) {
  try {
    if (await getCurrentPrincipal(request)) throw redirect("/dashboard");
  } catch (error) {
    if (error instanceof Response) throw error;
    console.warn("Home session lookup failed; rendering anonymous fallback.", error);
  }

  try {
    return { host: await loadHostConfig() };
  } catch (error) {
    console.warn("Home host config lookup failed; rendering fallback host.", error);
    return { host: FALLBACK_HOST };
  }
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Doco" }];
  return [{ title: `${data.host.name} · Doco` }];
}

/** Outcome-framed reasons to adopt Doco. */
const BENEFITS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Onboard people and agents in minutes",
    body: "New contributors inherit the reasoning behind the code — not just the code itself.",
  },
  {
    title: "Agents stop relitigating settled calls",
    body: "Before they act, agents search the doco — so they build on prior decisions instead of contradicting them.",
  },
  {
    title: "Decisions outlive the people who made them",
    body: "Turnover, re-orgs, and reset context windows no longer erase your institutional memory.",
  },
  {
    title: "One source of truth for humans and AI",
    body: "The same structured record powers your team and every agent working alongside them.",
  },
];

/** What makes Doco different from a wiki, an ADR folder, or a chat log. */
const FEATURES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "A typed knowledge graph, not a wiki",
    body: "Decisions, Rules, Intents, Actions, and References — each a first-class node with the right shape, never a wall of prose.",
  },
  {
    title: "Relationships are first-class",
    body: "Edges link a decision to the rule it spawned and an action to who performed it — trace cause and effect, don't just read pages.",
  },
  {
    title: "Built for agents from the ground up",
    body: "A native MCP server, OAuth 2.1, and a shared protocol let Claude Code, Cursor, and Codex discover and query your doco automatically.",
  },
  {
    title: "Semantic search across the lifetime",
    body: "Ask in plain language and get the ranked decisions and rules that actually bear on the question.",
  },
  {
    title: "Perspectives that visualize the graph",
    body: "Business-process maps, glossaries, and org trees — live views built from the same nodes, not diagrams that rot.",
  },
  {
    title: "Traceable to code, append-only by design",
    body: "Link any node to the exact file and line that implements it, on a history that's only ever added to.",
  },
];

/** The three-step adoption loop. */
const STEPS: ReadonlyArray<{ n: string; title: string; body: string }> = [
  {
    n: "1",
    title: "Connect",
    body: "Run the connect wizard and Doco commits a few files so every teammate and agent finds the same memory.",
  },
  {
    n: "2",
    title: "Capture",
    body: 'As decisions get made and rules emerge, you (or your agent) just "doco it." The why lands as a typed node the moment it forms.',
  },
  {
    n: "3",
    title: "Recall",
    body: "Anyone — human or agent — searches before acting, and builds on what the project already knows.",
  },
];

/**
 * The primary call to action. Reused verbatim in the hero and the closing
 * band, so it lives in one place. Joining a workspace is no longer a wizard —
 * humans arrive via an invite link, agents via the hosted MCP connector at /mcp
 * — so the only landing-page action is creating a workspace.
 */
function PrimaryCtas() {
  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <Link
        to="/new-workspace"
        className="neu-surface-interactive group rounded-lg border border-primary bg-card px-6 py-8 text-left transition-colors hover:border-primary"
      >
        <div className="text-base font-semibold">Create a new workspace</div>
        <div className="mt-2 text-xs text-muted-foreground">
          Start a shared memory for your team and its agents.
        </div>
      </Link>
    </div>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="neu-header border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
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

      <main className="flex-1">
        {/* Hero */}
        <section className="px-6 py-16 md:py-24">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
            <DocoMark height={88} />
            <h1 className="text-3xl font-bold leading-tight md:text-5xl">
              Shared memory for AI and teams
            </h1>
            <PrimaryCtas />
          </div>
        </section>

        {/* Benefits */}
        <section className="border-t border-border bg-card px-6 py-16">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">
              Stop losing the &ldquo;why&rdquo;
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted-foreground">
              Review comments scroll away, threads vanish, and the reasoning lives in one person's
              head — until they leave or an agent's context resets. Doco keeps it.
            </p>
            <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {BENEFITS.map((benefit) => (
                <div
                  key={benefit.title}
                  className="neu-surface rounded-lg border border-border bg-card p-6 text-left"
                >
                  <div className="text-base font-semibold">{benefit.title}</div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {benefit.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Unique functionality */}
        <section className="border-t border-border px-6 py-16">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">
              Not another wiki — a living graph
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted-foreground">
              Doco captures structure, relationships, and provenance that prose docs can't.
            </p>
            <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="neu-surface rounded-lg border border-border bg-card p-6 text-left"
                >
                  <div className="text-base font-semibold">{feature.title}</div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-border bg-card px-6 py-16">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center text-xl font-bold md:text-2xl">Connect, capture, recall</h2>
            <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
              {STEPS.map((step) => (
                <div key={step.n} className="text-left">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-sm font-bold text-primary">
                    {step.n}
                  </div>
                  <div className="mt-4 text-base font-semibold">{step.title}</div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Agents welcome */}
        <section className="border-t border-border px-6 py-16">
          <div className="neu-surface mx-auto max-w-3xl rounded-lg border border-border bg-card p-8 text-center">
            <h2 className="text-lg font-bold md:text-xl">Your AI can read this too</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Doco is as usable by your agents as by you. Point any agent at{" "}
              <a className="text-primary underline" href="/llms.txt">
                /llms.txt
              </a>{" "}
              and it self-onboards — authenticates, reads the protocol, and starts contributing to
              the shared record. Zero install.
            </p>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="border-t border-border bg-card px-6 py-16">
          <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 text-center">
            <h2 className="text-xl font-bold md:text-2xl">Start your project's memory today</h2>
            <PrimaryCtas />
          </div>
        </section>
      </main>

      <footer className="neu-header border-t border-border bg-card px-6 py-8">
        <div className="neu-surface mx-auto max-w-3xl rounded-lg bg-card p-5 text-left text-xs text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">
            AI agents reading this: don't click the buttons above.
          </p>
          <p className="mb-0">
            The buttons are for humans. Your zero-install recipe lives at{" "}
            <a className="text-primary underline" href="/llms.txt">
              /llms.txt
            </a>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}
