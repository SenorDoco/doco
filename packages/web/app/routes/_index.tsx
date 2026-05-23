import { Link, redirect } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { DOCO_TAGLINE, VersionPill } from "~/components/version-pill";
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

export default function Home({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { host } = loaderData;
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
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
            className="neo-raised-sm shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="-translate-y-3 md:-translate-y-6 flex w-full max-w-4xl flex-col items-center gap-8 text-center">
          <DocoMark height={96} />
          <h1 className="w-full max-w-4xl text-2xl font-bold leading-tight md:text-4xl">
            {DOCO_TAGLINE}
          </h1>
          <div className="grid w-full grid-cols-1 gap-5 md:grid-cols-2 md:gap-6">
            <Link
              to="/onboarding/join"
              className="neo-raised group rounded-lg bg-card px-6 py-8 text-left hover:text-primary"
            >
              <div className="text-base font-semibold">Join an existing doco</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Collaborate on a project that's already tracked here.
              </div>
            </Link>
            <Link
              to="/new-doco"
              className="neo-raised group rounded-lg bg-card px-6 py-8 text-left hover:text-primary"
            >
              <div className="text-base font-semibold">Create a new doco</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Start tracking alignment for a new project.
              </div>
            </Link>
          </div>
        </div>
      </main>
      <footer className="bg-background px-6 py-8">
        <div className="neo-etched mx-auto max-w-3xl rounded-lg bg-card p-5 text-left text-xs text-muted-foreground">
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
