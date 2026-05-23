import { Link, redirect } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";

import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { findPrincipalById, getSessionPrincipalId } from "~/lib/session.server";

/**
 * /sign-in (ADR-095) — GitHub OAuth is the only path. Anyone with a
 * cookie session that resolves to a real Principal is redirected straight
 * to `/dashboard` (or `?next=`).
 *
 * Accepts `?next=<relative-path>` for deep-link return-after-sign-in
 * (e.g. private-Doco entity URLs that redirect anonymous visitors here).
 * Open-redirect guard: `next` must start with a single `/` — protocol
 * and host-relative URLs (`//evil.com`, `https://…`) are dropped.
 */
function safeNext(input: string | null | undefined): string | null {
  if (!input) return null;
  if (input.length < 2 || input[0] !== "/" || input[1] === "/") return null;
  return input;
}

export async function loader({ request }: { request: Request }) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const id = getSessionPrincipalId(request);
  if (id && (await findPrincipalById(id))) throw redirect(next ?? "/dashboard");
  return { next };
}

export function meta() {
  return [{ title: "Sign in · Doco" }];
}

export default function SignIn({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { next } = loaderData;
  return (
    <div className="min-h-screen bg-background">
      <header className="bg-background">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-md px-6 py-10 space-y-4">
        <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Sign in" }]} />
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to={next ? `/auth/github?return=${encodeURIComponent(next)}` : "/auth/github"}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold"
            >
              <GitHubMark />
              Continue with GitHub
            </Link>

            <p className="mt-4 text-xs text-muted-foreground">
              New here?{" "}
              <Link to="/sign-up" className="text-primary hover:underline">
                Create an account
              </Link>
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
