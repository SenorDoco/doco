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
// name request is rejected.

import { getUserByGithubLogin, withClient } from "@doco/db";
import { Form, redirect } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { setSessionCookie } from "~/lib/session.server";

const TEST_USERNAMES = ["doco-test-harness", "doco-test-alice", "doco-test-bob"] as const;
type TestUsername = (typeof TEST_USERNAMES)[number];
const TEST_USERNAME = TEST_USERNAMES[0];

/**
 * Ensure a user row exists for the test name and return its id.
 *
 * The session cookie holds a `user_<ulid>` (per session.server.ts):
 * sign-in is identity, not principal-node. Inserting into `users` is
 * the right home for "the runtime that's holding this session,"
 * matching the GitHub OAuth path.
 */
async function ensureTestUser(githubLogin: TestUsername): Promise<string> {
  const existing = await getUserByGithubLogin(githubLogin);
  if (existing) return existing.id;
  const id = `user_${ulid()}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, github_login, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        githubLogin,
        JSON.stringify({
          id,
          github_login: githubLogin,
          note: "Lazy-created by /auth/dev-signin for testing.",
        }),
      ],
    );
  });
  const reloaded = await getUserByGithubLogin(githubLogin);
  if (!reloaded) throw new Error("ensureTestUser: post-insert lookup failed");
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
  usernames: readonly string[];
  defaultUsername: string;
}

export async function loader() {
  return Response.json({
    usernames: TEST_USERNAMES,
    defaultUsername: TEST_USERNAME,
  } satisfies LoaderData);
}

function isTestUsername(value: string): value is TestUsername {
  return (TEST_USERNAMES as readonly string[]).includes(value);
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const requested = String(form.get("username") ?? TEST_USERNAME).trim();
  if (!isTestUsername(requested)) {
    return new Response(
      `dev-signin restricted to: ${TEST_USERNAMES.join(", ")}. Got "${requested}".`,
      { status: 403 },
    );
  }
  const userId = await ensureTestUser(requested);
  const next = form.get("next");
  const target =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
      ? next
      : "/dashboard";
  return redirect(target, {
    headers: { "Set-Cookie": setSessionCookie(userId) },
  });
}

export default function DevSignin({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  return (
    <main style={{ maxWidth: 480, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
      <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Dev sign-in" }]} className="mb-2" />
      <h1>Dev sign-in</h1>
      <p style={{ color: "#a00", marginBottom: 16 }}>
        ⚠️ Testing-only. Signs in as one of the dedicated test principals. Each starts with no Doco
        grants — pair this with an invite mint to give it access for a specific test run.
      </p>
      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Sign in as:
          <select name="username" defaultValue={loaderData.defaultUsername}>
            {loaderData.usernames.map((u) => (
              <option key={u} value={u}>
                {u}
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
