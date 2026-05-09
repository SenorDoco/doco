import { Form, Link, redirect } from "react-router";
import { getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import {
  findPrincipalById,
  getSessionPrincipalId,
  listSignInCandidates,
  setSessionCookie,
} from "~/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { EvaloMark } from "~/components/evalo-mark";

export function loader({ request }: { request: Request }) {
  if (getMode() !== "host") {
    throw new Response("Sign-in is only available in host mode.", { status: 404 });
  }
  // Already signed in? bounce home.
  const id = getSessionPrincipalId(request);
  if (id && findPrincipalById(id)) {
    throw redirect("/");
  }
  return { users: listSignInCandidates(), host: loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const principalId = String(form.get("principal_id") ?? "");
  if (!findPrincipalById(principalId)) {
    return { error: "That user no longer exists." };
  }
  return redirect("/", { headers: { "Set-Cookie": setSessionCookie(principalId) } });
}

export function meta() {
  return [{ title: "Sign in · Evalo" }];
}

export default function SignIn({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { users, host } = loaderData;
  return (
    <div>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Evalo home">
            <EvaloMark height={28} />
          </Link>
          <span className="text-xs text-muted-foreground">/ {host.name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-md px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Local-dev mode: pick a registered User to act as. Production will swap to GitHub OAuth (ADR-034).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {users.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No users yet.{" "}
                <Link to="/sign-up" className="text-primary hover:underline">
                  Create the first one →
                </Link>
              </p>
            ) : (
              <ul className="space-y-2">
                {users.map((u) => (
                  <li key={u.id}>
                    <Form method="post">
                      <input type="hidden" name="principal_id" value={u.id} />
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
            )}
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
