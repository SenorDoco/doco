import { Link } from "react-router";
import { readOAuthConfig, setOAuthReturnCookie, startOAuth } from "~/lib/oauth.server";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

/**
 * GET /auth/github — Kicks off GitHub OAuth (ADR-095). If env vars
 * (DOCO_GITHUB_CLIENT_ID / DOCO_GITHUB_CLIENT_SECRET) are missing, renders
 * a setup page instead of crashing. Accepts `?return=<path>` to redirect
 * to a specific path after sign-in (only same-origin paths are honored).
 */
export async function loader({ request }: { request: Request }) {
  const config = readOAuthConfig(request);
  if (!config) {
    return { error: "missing_config" as const };
  }
  const reqUrl = new URL(request.url);
  const returnParam = reqUrl.searchParams.get("return");
  const { url, setCookie } = startOAuth(config);
  const headers = new Headers();
  headers.append("Set-Cookie", setCookie);
  // Stash where to return to after the callback finishes. Same-origin only:
  // value must start with a single "/" — open redirects rejected.
  if (returnParam && returnParam.startsWith("/") && !returnParam.startsWith("//")) {
    headers.append("Set-Cookie", setOAuthReturnCookie(returnParam));
  }
  headers.set("Location", url);
  return new Response(null, { status: 302, headers });
}

export function meta() {
  return [{ title: "Continue with GitHub · Doco" }];
}

export default function AuthGitHub({
  loaderData,
}: {
  loaderData: { error: "missing_config" } | undefined;
}) {
  // The success branch returns a Response (a redirect); only the error branch
  // reaches this component.
  if (!loaderData || loaderData.error !== "missing_config") return null;
  return (
    <div>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>GitHub OAuth not configured</CardTitle>
            <CardDescription>
              Account creation requires GitHub OAuth (ADR-095). The dev environment is missing the
              required env vars.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ol className="list-decimal pl-5 space-y-2 text-foreground">
              <li>
                Register a GitHub OAuth App at{" "}
                <a
                  className="text-primary hover:underline"
                  href="https://github.com/settings/developers"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/settings/developers
                </a>
                .
              </li>
              <li>
                Set the Authorization callback URL to match the host you'll use to reach the dev
                server. By default Doco derives the callback from the request URL, so if you visit{" "}
                <code className="rounded bg-input px-1 py-0.5 font-mono">http://localhost:5173</code>{" "}
                set it to{" "}
                <code className="rounded bg-input px-1 py-0.5 font-mono">
                  http://localhost:5173/auth/github/callback
                </code>
                . GitHub does strict host matching, so <code className="rounded bg-input px-1 py-0.5 font-mono">localhost</code>{" "}
                and <code className="rounded bg-input px-1 py-0.5 font-mono">127.0.0.1</code> are
                treated as different URLs — pick one and stick with it (or set{" "}
                <code className="rounded bg-input px-1 py-0.5 font-mono">DOCO_GITHUB_REDIRECT_URI</code>{" "}
                in <code className="rounded bg-input px-1 py-0.5">.env</code> to override).
              </li>
              <li>
                Add the credentials to <code className="rounded bg-input px-1 py-0.5">./.env</code>:
                <pre className="mt-2 overflow-x-auto rounded bg-input p-3 text-xs font-mono">
{`DOCO_GITHUB_CLIENT_ID=<from the OAuth app>
DOCO_GITHUB_CLIENT_SECRET=<from the OAuth app>`}
                </pre>
              </li>
              <li>
                Restart the dev server, then{" "}
                <Link to="/auth/github" className="text-primary hover:underline">
                  try again
                </Link>
                .
              </li>
            </ol>
            <p className="text-xs text-muted-foreground pt-2">
              No mock fallback — that would let agents bypass identity verification. The two-minute
              setup is worth it. (See ADR-095.)
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
