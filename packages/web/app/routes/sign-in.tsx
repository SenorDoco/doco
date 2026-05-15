import { Form, Link, redirect } from "react-router";

import {
  findPrincipalById,
  getSessionPrincipalId,
  listSignInCandidates,
  setSessionCookie,
} from "~/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";

/**
 * /sign-in (ADR-095) — GitHub OAuth is the primary path. A localhost
 * identity-picker is offered as a switch-account affordance when
 * DOCO_LOCALHOST_PICKER=1; production-grade hosts leave it off.
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
  if (id && await findPrincipalById(id)) throw redirect(next ?? "/dashboard");
  const pickerEnabled = process.env.DOCO_LOCALHOST_PICKER === "1";
  const users = pickerEnabled ? await listSignInCandidates() : [];
  return { users, pickerEnabled, next };
}

export async function action({ request }: { request: Request }) {
  if (process.env.DOCO_LOCALHOST_PICKER !== "1") {
    return { error: "Picker sign-in is disabled. Use Continue with GitHub." };
  }
  const form = await request.formData();
  const principalId = String(form.get("principal_id") ?? "");
  if (!await findPrincipalById(principalId)) {
    return { error: "That user no longer exists." };
  }
  const next = safeNext(String(form.get("next") ?? "")) ?? "/dashboard";
  return redirect(next, { headers: { "Set-Cookie": setSessionCookie(principalId) } });
}

export function meta() {
  return [{ title: "Sign in · Doco" }];
}

export default function SignIn({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { users, pickerEnabled, next } = loaderData;
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
      <main className="mx-auto max-w-md px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to={next ? `/auth/github?next=${encodeURIComponent(next)}` : "/auth/github"}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <GitHubMark />
              Continue with GitHub
            </Link>

            {pickerEnabled && users.length > 0 ? (
              <>
                <div className="my-4 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span>or switch local identity</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <ul className="space-y-2">
                  {users.map((u) => (
                    <li key={u.id}>
                      <Form method="post">
                        <input type="hidden" name="principal_id" value={u.id} />
                        {next ? <input type="hidden" name="next" value={next} /> : null}
                        <button
                          type="submit"
                          className="w-full rounded-md border border-border bg-input px-3 py-2 text-left transition-colors hover:border-primary hover:bg-card"
                        >
                          <div className="text-sm font-semibold">{u.username}</div>
                          {u.email ? (
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          ) : null}
                        </button>
                      </Form>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  This picker is a local-dev convenience (DOCO_LOCALHOST_PICKER=1). Production hosts
                  leave it off — sign-in is GitHub-only there.
                </p>
              </>
            ) : null}

            {actionData?.error ? (
              <p className="mt-3 text-xs text-destructive">{actionData.error}</p>
            ) : null}

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
