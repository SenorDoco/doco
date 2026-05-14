import { redirect } from "react-router";
import { addPrincipal, findPrincipalByGitHubLogin } from "@doco/host";
import { rootDir } from "~/lib/db.server";
import {
  clearOAuthStateCookie,
  exchangeCodeForToken,
  fetchGitHubPrimaryEmail,
  fetchGitHubUser,
  readOAuthConfig,
  verifyOAuthState,
} from "~/lib/oauth.server";
import { setSessionCookie } from "~/lib/session";

/**
 * GET /auth/github/callback — finishes the OAuth round-trip (ADR-095).
 * On success: creates a Principal (type:person) if first time, or signs in
 * the existing one. Sets the session cookie and redirects home.
 */
export async function loader({ request }: { request: Request }) {
  const config = readOAuthConfig(request);
  if (!config) throw new Response("OAuth not configured.", { status: 500 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Response("Missing code or state.", { status: 400 });

  const cookieHeader = request.headers.get("cookie");
  const verdict = verifyOAuthState(config, state, cookieHeader);
  if (verdict !== "valid") {
    throw new Response(`OAuth state ${verdict}.`, { status: 400 });
  }

  // Exchange code for token; fetch profile.
  const { accessToken } = await exchangeCodeForToken(config, code);
  const gh = await fetchGitHubUser(accessToken);
  const email = (await fetchGitHubPrimaryEmail(accessToken)) ?? gh.email ?? undefined;

  // create-or-find on GitHub login.
  const root = rootDir();
  let principalId: string;
  const existing = await findPrincipalByGitHubLogin(root, gh.login);
  if (existing) {
    principalId = existing.id;
  } else {
    principalId = await addPrincipal(root, {
      username: gh.login.toLowerCase(),
      display_name: gh.name ?? gh.login,
      ...(email ? { email } : {}),
      github_identity: {
        github_id: String(gh.id),
        github_login: gh.login,
        ...(email ? { email } : {}),
      },
    });
  }

  // Combine cookies in one Set-Cookie response (Remix supports an array via
  // Headers.append). Clear the OAuth-state cookie and set the session cookie.
  const headers = new Headers();
  headers.append("Set-Cookie", clearOAuthStateCookie());
  headers.append("Set-Cookie", setSessionCookie(principalId));
  headers.set("Location", "/dashboard");
  return new Response(null, { status: 302, headers });
}

export default function GitHubCallback() {
  return null;
}
