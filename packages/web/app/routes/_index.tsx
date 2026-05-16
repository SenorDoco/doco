import { Link, redirect } from "react-router";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";

/**
 * Host home — anonymous landing only. Signed-in users are redirected to
 * /dashboard so the marketing copy never gets in the way of their work.
 */
export async function loader({ request }: { request: Request }) {
  if (await getCurrentPrincipal(request)) throw redirect("/dashboard");
  return { host: await loadHostConfig() };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Doco" }];
  return [{ title: `${data.host.name} · Doco` }];
}

export default function Home({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { host } = loaderData;
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
              <DocoMark height={28} />
            </Link>
            <VersionPill />
          </div>
          <Link
            to="/sign-in"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="flex max-w-2xl flex-col items-center gap-6 text-center">
          <DocoMark height={96} />
          <p className="max-w-lg text-sm text-muted-foreground">
            AI-native documentation of important ideas, rules, and evals.
          </p>
          <h1 className="text-lg font-bold tracking-tight pt-2">What are you here to do?</h1>

          <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <Link
              to="/onboarding/join"
              className="group rounded-lg border border-border bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">Join an existing doco</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Collaborate on a project that's already tracked here.
              </div>
            </Link>
            <Link
              to="/onboarding/create"
              className="group rounded-lg border border-border bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">Create a new doco</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Start tracking alignment for a new project.
              </div>
            </Link>
          </div>

          <p className="max-w-md pt-6 text-xs text-muted-foreground">
            Are you an AI agent and don't know the answer? Ask whomever prompted you which way
            to go.
          </p>
        </div>
      </main>
    </div>
  );
}
