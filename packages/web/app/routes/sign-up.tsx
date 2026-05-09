import { Form, Link, redirect } from "react-router";
import { addPrincipal } from "@evalo/host";
import { rootDir, getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal, setSessionCookie } from "~/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { EvaloMark } from "~/components/evalo-mark";

export function loader({ request }: { request: Request }) {
  if (getMode() !== "host") {
    throw new Response("Sign-up is only available in host mode.", { status: 404 });
  }
  if (getCurrentPrincipal(request)) throw redirect("/");
  return { host: loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const email = String(form.get("email") ?? "").trim() || undefined;
  if (!username) return { error: "Username is required." };
  try {
    const id = await addPrincipal(rootDir(), { username, ...(email ? { email } : {}) });
    return redirect("/", { headers: { "Set-Cookie": setSessionCookie(id) } });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function meta() {
  return [{ title: "Sign up · Evalo" }];
}

export default function SignUp({ loaderData, actionData }: { loaderData: Awaited<ReturnType<typeof loader>>; actionData?: { error?: string } | undefined }) {
  return (
    <div>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Evalo home">
            <EvaloMark height={28} />
          </Link>
          <span className="text-xs text-muted-foreground">/ {loaderData.host.name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-md px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Create an account</CardTitle>
            <CardDescription>
              Local-dev: pick a username (lowercase, kebab-case). Production swaps to GitHub OAuth (ADR-034).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Username</span>
                <input
                  type="text"
                  name="username"
                  required
                  autoFocus
                  pattern="[a-z0-9_-]+"
                  placeholder="e.g. alice"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Email (optional)</span>
                <input
                  type="email"
                  name="email"
                  placeholder="alice@example.com"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <button
                type="submit"
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Create account
              </button>
              <p className="text-xs text-muted-foreground">
                Already have an account?{" "}
                <Link to="/sign-in" className="text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
