import { Form, Link, redirect } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { isValidSignupInviteCode, setSignupInviteCookie } from "~/lib/invite.server";
import { getCurrentPrincipal } from "~/lib/session.server";

/**
 * /sign-up — invite-gated, GitHub-OAuth account creation (ADR-095).
 * Existing accounts still sign in through /sign-in; creating a new person
 * Principal requires a valid invite code before the OAuth round-trip.
 */
export async function loader({ request }: { request: Request }) {
  if (await getCurrentPrincipal(request)) throw redirect("/dashboard");
  const error = new URL(request.url).searchParams.get("error");
  return {
    error: error === "invite_required" ? "Enter an invite code before creating an account." : null,
  };
}

export async function action({ request }: { request: Request }) {
  if (await getCurrentPrincipal(request)) throw redirect("/dashboard");
  const form = await request.formData();
  const inviteCode = String(form.get("invite_code") ?? "");
  if (!isValidSignupInviteCode(inviteCode)) {
    return { error: "That invite code is not valid." };
  }
  return redirect("/auth/github?return=%2Fdashboard", {
    headers: { "Set-Cookie": setSignupInviteCookie() },
  });
}

export function meta() {
  return [{ title: "Sign up · Doco" }];
}

export default function SignUp({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const error = actionData?.error ?? loaderData.error;
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
      <main className="mx-auto max-w-md px-6 py-10 space-y-4">
        <Breadcrumb
          items={[
            { label: "Home", to: "/" },
            { label: "Sign up" },
          ]}
        />
        <Card>
          <CardHeader>
            <CardTitle>Create an account</CardTitle>
            <CardDescription>Enter your invite code, then continue with GitHub.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Invite code</span>
                <input
                  type="text"
                  name="invite_code"
                  required
                  autoComplete="one-time-code"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              {error ? (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                <GitHubMark />
                Continue with GitHub
              </button>
            </Form>
            <p className="mt-3 text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link to="/sign-in" className="text-primary hover:underline">
                Sign in
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
