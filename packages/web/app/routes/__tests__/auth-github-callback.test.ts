import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addUser: vi.fn(),
  findUserByGitHubLogin: vi.fn(),
  findInvite: vi.fn(),
}));

vi.mock("@doco/host", () => ({
  addUser: mocks.addUser,
  findUserByGitHubLogin: mocks.findUserByGitHubLogin,
}));

vi.mock("~/lib/db.server", () => ({
  rootDir: () => "/tmp/doco",
}));

vi.mock("~/lib/invite-store.server", () => ({
  InviteStore: { forDoco: () => ({ findInvite: mocks.findInvite }) },
}));

vi.mock("~/lib/oauth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/oauth.server")>()),
  readOAuthConfig: () => ({ clientId: "id", clientSecret: "secret", redirectUri: "uri" }),
  verifyOAuthState: () => "valid",
  exchangeCodeForToken: async () => ({ accessToken: "gh_token" }),
  fetchGitHubUser: async () => ({ id: 42, login: "Newcomer", email: null }),
  fetchGitHubPrimaryEmail: async () => null,
}));

import { setSignupInviteCookie } from "~/lib/invite.server";
import { setOAuthReturnCookie } from "~/lib/oauth.server";
import { loader } from "../auth.github.callback";

function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

function callback(cookies: string[]): Request {
  return new Request("https://doco.test/auth/github/callback?code=c&state=s", {
    headers: { cookie: cookies.join("; ") },
  });
}

function invite(overrides: Record<string, unknown> = {}) {
  return { code: "abc123", status: "pending", minted_by_user_id: "user_owner", ...overrides };
}

describe("/auth/github/callback — who may create an account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserByGitHubLogin.mockResolvedValue(null);
    mocks.addUser.mockResolvedValue("user_new");
    mocks.findInvite.mockResolvedValue(invite());
  });

  it("creates the account of a newcomer following a user's pending invite, without the signup code", async () => {
    const res = await loader({
      request: callback([cookieValue(setOAuthReturnCookie("/invite/abc123"))]),
    });

    expect(mocks.findInvite).toHaveBeenCalledWith("abc123");
    expect(mocks.addUser).toHaveBeenCalledWith(expect.objectContaining({ username: "newcomer" }));
    expect(res.headers.get("Location")).toBe("/invite/abc123");
  });

  it.each([
    ["consumed", invite({ status: "consumed" })],
    ["expired", invite({ status: "expired" })],
    ["revoked", invite({ status: "revoked" })],
    ["minted by no user", invite({ minted_by_user_id: null })],
    ["missing", null],
  ])("sends a newcomer whose invite is %s to /sign-up for the code", async (_label, found) => {
    mocks.findInvite.mockResolvedValue(found);

    const res = await loader({
      request: callback([cookieValue(setOAuthReturnCookie("/invite/abc123"))]),
    });

    expect(mocks.addUser).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/sign-up?error=invite_required");
  });

  it("sends a newcomer who isn't following an invite to /sign-up for the code", async () => {
    const res = await loader({
      request: callback([cookieValue(setOAuthReturnCookie("/workspaces"))]),
    });

    expect(mocks.findInvite).not.toHaveBeenCalled();
    expect(mocks.addUser).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/sign-up?error=invite_required");
  });

  it("creates the account of a newcomer who entered the signup code", async () => {
    const res = await loader({ request: callback([cookieValue(setSignupInviteCookie())]) });

    expect(mocks.addUser).toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/workspaces");
  });
});
