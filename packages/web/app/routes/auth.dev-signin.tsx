// /auth/dev-signin — bypass GitHub OAuth for end-to-end testing.
//
// HARD-GATED: only works when DOCO_DEV_AUTH=1 is set in the host
// environment. In production this is OFF by default; flip it on for
// the duration of a testing window and back off after.
//
// Two forms:
//   GET  /auth/dev-signin                — list signable usernames + form
//   POST /auth/dev-signin (form `username`) — sets `doco_session`
//                                              cookie for that user
//
// Why this exists: the GitHub OAuth callback fetches the user's
// GitHub identity over the network — unreachable from sandboxed agent
// runtimes, so we can't exercise the OAuth-server side of MCP-OAuth
// from a curl-only test bed. This route lets a test harness post the
// username it wants to be, get the cookie, and proceed as if it had
// signed in normally.

import { Form, redirect } from "react-router";
import { listPrincipals } from "@doco/db";
import { findPrincipalByUsername, setSessionCookie } from "~/lib/session";

function devAuthEnabled(): boolean {
  return process.env.DOCO_DEV_AUTH === "1";
}

interface LoaderData {
  enabled: boolean;
  humans: { id: string; username: string }[];
}

export async function loader() {
  if (!devAuthEnabled()) {
    return Response.json({ enabled: false, humans: [] } satisfies LoaderData, { status: 404 });
  }
  const all = await listPrincipals({});
  const humans = all
    .filter((p) => p.type === "human")
    .map((p) => ({ id: p.id, username: p.username }));
  return Response.json({ enabled: true, humans } satisfies LoaderData);
}

export async function action({ request }: { request: Request }) {
  if (!devAuthEnabled()) {
    return new Response("dev-signin disabled", { status: 404 });
  }
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  if (!username) {
    return new Response("username required", { status: 400 });
  }
  const principal = await findPrincipalByUsername(username);
  if (!principal) {
    return new Response(`no principal with username "${username}"`, { status: 404 });
  }
  const next = form.get("next");
  const target = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return redirect(target, {
    headers: { "Set-Cookie": setSessionCookie(principal.id) },
  });
}

export default function DevSignin({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  if (!loaderData.enabled) {
    return (
      <main style={{ maxWidth: 480, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
        <h1>dev-signin disabled</h1>
        <p>Set <code>DOCO_DEV_AUTH=1</code> in the host environment to enable.</p>
      </main>
    );
  }
  return (
    <main style={{ maxWidth: 480, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Dev sign-in</h1>
      <p style={{ color: "#a00", marginBottom: 16 }}>
        ⚠️ Testing-only. Skips GitHub OAuth. Sets the <code>doco_session</code> cookie as the
        selected user.
      </p>
      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Sign in as (existing human principal):
          <select name="username" defaultValue={loaderData.humans[0]?.username ?? ""}>
            {loaderData.humans.map((h) => (
              <option key={h.id} value={h.username}>
                {h.username}
              </option>
            ))}
          </select>
        </label>
        <label>
          Redirect to (optional, must start with /):
          <input name="next" type="text" defaultValue="/dashboard" />
        </label>
        <button type="submit">Sign in</button>
      </Form>
    </main>
  );
}
