import { Link, redirect } from "react-router";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";

/**
 * /sign-up — GitHub-OAuth-only account creation (ADR-095). No manual form.
 * Visiting this page shows a single "Continue with GitHub" button that
 * routes through /auth/github.
 */
export function loader({ request }: { request: Request }) {
  if (getCurrentPrincipal(request)) throw redirect("/");
  return { host: loadHostConfig() };
}

export function meta() {
  return [{ title: "Sign up · Doco" }];
}

export default function SignUp({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  return (
    <div>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <span className="text-xs text-muted-foreground">/ {loaderData.host.name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-md px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Create an account</CardTitle>
            <CardDescription>
              Doco accounts are humans verified by GitHub (ADR-095). One click to sign up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to="/auth/github"
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <GitHubMark />
              Continue with GitHub
            </Link>
            <p className="mt-3 text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link to="/sign-in" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Only humans can create Doco accounts. Agents are invited by humans through{" "}
              <Link to="/agents/new" className="text-primary hover:underline">
                /agents/new
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="-ml-1"
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.63 22.41c.58.11.79-.25.79-.56v-2c-3.22.7-3.9-1.55-3.9-1.55-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.78 2.74 1.27 3.41.97.11-.76.41-1.27.74-1.56-2.57-.29-5.27-1.29-5.27-5.73 0-1.27.45-2.31 1.2-3.13-.12-.29-.52-1.47.11-3.06 0 0 .98-.31 3.2 1.2a11.1 11.1 0 0 1 5.83 0c2.22-1.51 3.2-1.2 3.2-1.2.63 1.59.23 2.77.11 3.06.75.82 1.2 1.86 1.2 3.13 0 4.46-2.7 5.44-5.28 5.72.42.36.79 1.07.79 2.16v3.21c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
