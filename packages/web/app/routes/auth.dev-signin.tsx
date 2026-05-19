// /auth/dev-signin — bypass GitHub OAuth for end-to-end testing.
//
// Always enabled on this host, but RESTRICTED to a single dedicated
// test principal (`doco-test-harness`) that the route lazy-creates on
// first call. The principal starts with no doco_users grants, so a
// hostile signin gets a session with access to nothing — same shape
// as a fresh GitHub signin before anyone has been invited.
//
// Two endpoints:
//   GET  /auth/dev-signin              — form / status
//   POST /auth/dev-signin               — set the doco_session cookie
//
// Why this exists: sandboxed agent runtimes (no outbound github.com)
// can't drive the full OAuth dance end-to-end without a way to
// shortcut the human GitHub-sign-in step. This route gives them that
// shortcut WITHOUT widening the credential surface — any other
// username request is rejected.

import { Form, redirect } from "react-router";
import { withClient } from "@doco/db";
import { findPrincipalByUsername, setSessionCookie } from "~/lib/session";

const TEST_USERNAME = "doco-test-harness";

async function ensureTestPrincipal(): Promise<string> {
  const existing = await findPrincipalByUsername(TEST_USERNAME);
  if (existing) {
    // Repair raw_yaml if the row was minted by an older version of
    // this route that omitted node_type — the indexer NULL-checks
    // entity_fts.node_type, so a malformed principal blocks every
    // future Doco-create rebuild on this host.
    await withClient(async (c) => {
      await c.query(
        `UPDATE principals
            SET raw_yaml = jsonb_set(
              COALESCE(raw_yaml::jsonb, '{}'::jsonb),
              '{node_type}',
              '"principal"'::jsonb,
              true
            )::text
          WHERE id = $1 AND (raw_yaml::jsonb ->> 'node_type') IS DISTINCT FROM 'principal'`,
        [existing.id],
      );
    });
    return existing.id;
  }
  const id = `principal_${ulid()}`;
  const raw_yaml = JSON.stringify({
    id,
    node_type: "principal",
    username: TEST_USERNAME,
    type: "human",
    note: "Lazy-created by /auth/dev-signin for testing. Has no doco_users grants by default.",
  });
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO principals (id, username, type, raw_yaml)
       VALUES ($1, $2, 'human', $3)
       ON CONFLICT (username) DO NOTHING`,
      [id, TEST_USERNAME, raw_yaml],
    );
  });
  const reloaded = await findPrincipalByUsername(TEST_USERNAME);
  if (!reloaded) throw new Error("ensureTestPrincipal: post-insert lookup failed");
  return reloaded.id;
}

// Minimal Crockford-base32 ULID without a dep — 26 chars, monotonic
// enough for a test ID. Pattern matches the rest of the codebase
// (`principal_01K...`) so any regex that expects 26 chars passes.
function ulid(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  let timePart = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    timePart = ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    randomPart += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return timePart + randomPart;
}

interface LoaderData {
  username: string;
  principalId: string | null;
}

export async function loader() {
  const existing = await findPrincipalByUsername(TEST_USERNAME);
  return Response.json({
    username: TEST_USERNAME,
    principalId: existing?.id ?? null,
  } satisfies LoaderData);
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const requested = String(form.get("username") ?? TEST_USERNAME).trim();
  if (requested !== TEST_USERNAME) {
    return new Response(
      `dev-signin restricted to "${TEST_USERNAME}". Got "${requested}".`,
      { status: 403 },
    );
  }
  const principalId = await ensureTestPrincipal();
  const next = form.get("next");
  const target =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
      ? next
      : "/dashboard";
  return redirect(target, {
    headers: { "Set-Cookie": setSessionCookie(principalId) },
  });
}

export default function DevSignin({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  return (
    <main style={{ maxWidth: 480, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Dev sign-in</h1>
      <p style={{ color: "#a00", marginBottom: 16 }}>
        ⚠️ Testing-only. Signs in as the dedicated <code>{loaderData.username}</code> principal.
        That account starts with no Doco grants — pair this with an invite mint to give it
        access for a specific test run.
      </p>
      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="hidden" name="username" value={loaderData.username} />
        <label>
          Redirect to (optional, must start with /):
          <input name="next" type="text" defaultValue="/dashboard" />
        </label>
        <button type="submit">
          Sign in as {loaderData.username}
          {loaderData.principalId ? "" : " (will create on first signin)"}
        </button>
      </Form>
    </main>
  );
}
