import { addUser, findUserByGitHubLogin } from "@doco/host";
import { redirect } from "react-router";
import {
  acceptInvite,
  clearSignupInviteCookie,
  inviteCodeIn,
  maySignUp,
} from "~/lib/invite.server";
import {
  clearOAuthReturnCookie,
  clearOAuthStateCookie,
  exchangeCodeForToken,
  fetchGitHubPrimaryEmail,
  fetchGitHubUser,
  readOAuthConfig,
  readOAuthReturnCookie,
  verifyOAuthState,
} from "~/lib/oauth.server";
import { setSessionCookie } from "~/lib/session.server";

/**
 * GET /auth/github/callback — finishes the OAuth round-trip (ADR-095).
 * On success: creates a user if first time, or signs in the
 * existing one. Sets the session cookie and redirects home. A newcomer
 * needs the signup code from /sign-up, or a user's pending invite to return
 * to (see maySignUp). Signing in from an invite accepts it, so the person
 * lands in what it grants, or back on the invite when it can't be accepted.
 */
export async function loader({ request }: { request: Request }) {
  const config = readOAuthConfig(request);
  if (!config) throw new Response("OAuth not configured.", { status: 500 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Response("Missing code or state.", { status: 400 });

  const cookieHeader = request.headers.get("cookie");
  const returnPath = readOAuthReturnCookie(cookieHeader);
  const verdict = verifyOAuthState(config, state, cookieHeader);
  if (verdict !== "valid") {
    throw new Response(`OAuth state ${verdict}.`, { status: 400 });
  }

  // Exchange code for token; fetch profile.
  const { accessToken } = await exchangeCodeForToken(config, code);
  const gh = await fetchGitHubUser(accessToken);
  const email = (await fetchGitHubPrimaryEmail(accessToken)) ?? gh.email ?? undefined;

  let userId: string;
  const existing = await findUserByGitHubLogin(gh.login);
  if (existing) {
    userId = existing.id;
  } else {
    if (!(await maySignUp(cookieHeader, returnPath))) {
      const headers = oauthCleanupHeaders();
      headers.append("Set-Cookie", clearSignupInviteCookie());
      headers.set("Location", "/sign-up?error=invite_required");
      return new Response(null, { status: 302, headers });
    }
    userId = await addUser({
      username: gh.login.toLowerCase(),
      ...(email ? { email } : {}),
      github_identity: {
        github_id: String(gh.id),
        github_login: gh.login,
        ...(email ? { email } : {}),
      },
    });
  }

  // Combine cookies in one Set-Cookie response (Remix supports an array via
  // Headers.append). Clear the OAuth-state cookie + return cookie and set
  // the session cookie. Honor `?return=` cookie if a sane same-origin path
  // is captured; default to /workspaces. Signing in from an invite (Human on
  // its page) accepts it: that choice already said the person wants in.
  const headers = oauthCleanupHeaders();
  headers.append("Set-Cookie", clearSignupInviteCookie());
  headers.append("Set-Cookie", setSessionCookie(userId));
  const inviteCode = inviteCodeIn(returnPath);
  const accepted = inviteCode ? await acceptInvite(inviteCode, userId) : null;
  headers.set(
    "Location",
    accepted && "to" in accepted ? accepted.to : (returnPath ?? "/workspaces"),
  );
  return new Response(null, { status: 302, headers });
}

export default function GitHubCallback() {
  return null;
}

function oauthCleanupHeaders(): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", clearOAuthStateCookie());
  headers.append("Set-Cookie", clearOAuthReturnCookie());
  return headers;
}
