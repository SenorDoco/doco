import { createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addUser: vi.fn(),
  findUserByGitHubLogin: vi.fn(),
  findInvite: vi.fn(),
  consumeInvite: vi.fn(),
  upsertWorkspaceUser: vi.fn(),
  startOnboarding: vi.fn(),
}));

vi.mock("@doco/host", () => ({
  addUser: mocks.addUser,
  findUserByGitHubLogin: mocks.findUserByGitHubLogin,
}));

vi.mock("@doco/db", () => ({
  getDocoById: vi.fn(),
  upsertDocoUser: vi.fn(),
  upsertWorkspaceUser: mocks.upsertWorkspaceUser,
  withClient: (callback: (c: unknown) => unknown) =>
    callback({ query: async () => ({ rows: [{ handle: "torre" }] }) }),
}));

vi.mock("~/lib/db.server", () => ({
  rootDir: () => "/tmp/doco",
}));

vi.mock("~/lib/invite-store.server", () => ({
  InviteStore: {
    forDoco: () => ({ findInvite: mocks.findInvite, consumeInvite: mocks.consumeInvite }),
  },
}));

vi.mock("~/lib/onboarding.server", () => ({
  startOnboarding: mocks.startOnboarding,
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

function fromInvite(): Request {
  return callback([cookieValue(setOAuthReturnCookie("/invite/abc123"))]);
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    code: "abc123",
    status: "pending",
    minted_by_user_id: "user_owner",
    grants: [
      { level: "workspace", target_id: "workspace_torre", role: "writer", write_types: ["*"] },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  mocks.findUserByGitHubLogin.mockResolvedValue(null);
  mocks.addUser.mockResolvedValue("user_new");
  mocks.findInvite.mockResolvedValue(invite());
  mocks.consumeInvite.mockResolvedValue(invite({ status: "consumed" }));
});

describe("/auth/github/callback — who may create an account", () => {
  it("creates the account of a newcomer following a user's pending invite, without the signup code", async () => {
    await loader({ request: fromInvite() });

    expect(mocks.findInvite).toHaveBeenCalledWith("abc123");
    expect(mocks.addUser).toHaveBeenCalledWith(expect.objectContaining({ username: "newcomer" }));
  });

  it.each([
    ["consumed", invite({ status: "consumed" })],
    ["expired", invite({ status: "expired" })],
    ["revoked", invite({ status: "revoked" })],
    ["minted by no user", invite({ minted_by_user_id: null })],
    ["missing", null],
  ])("sends a newcomer whose invite is %s to /sign-up for the code", async (_label, found) => {
    mocks.findInvite.mockResolvedValue(found);

    const res = await loader({ request: fromInvite() });

    expect(mocks.addUser).not.toHaveBeenCalled();
    expect(mocks.consumeInvite).not.toHaveBeenCalled();
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

  it("sends a newcomer with a signup cookie the server didn't set to /sign-up for the code", async () => {
    // Signed the way the cookie used to be, under the default key in the
    // public source: it must not stand in for the code.
    const payload = `v1.${Math.floor(Date.now() / 1000)}`;
    const sig = createHmac("sha256", "doco-dev-default-invite-key").update(payload).digest("hex");

    const res = await loader({ request: callback([`doco_signup_invite=${payload}.${sig}`]) });

    expect(mocks.addUser).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/sign-up?error=invite_required");
  });
});

// Alexander, 2026-10-08: choosing Human on an invite and signing in with
// GitHub already says the person wants in, so they shouldn't have to click
// Accept invite when they come back.
describe("/auth/github/callback — signing in from an invite accepts it", () => {
  it("joins a newcomer to the invite's workspace and takes them to its page", async () => {
    const res = await loader({ request: fromInvite() });

    expect(mocks.consumeInvite).toHaveBeenCalledWith("abc123", "user_new");
    expect(mocks.upsertWorkspaceUser).toHaveBeenCalledWith({
      workspace_id: "workspace_torre",
      user_id: "user_new",
      role: "writer",
      write_types: ["*"],
    });
    expect(mocks.startOnboarding).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "workspace_torre",
      userId: "user_new",
      joinedAs: "invitee",
    });
    expect(res.headers.get("Location")).toBe("/workspaces/torre");
  });

  it("joins someone who already has an account the same way", async () => {
    mocks.findUserByGitHubLogin.mockResolvedValue({ id: "user_alice" });

    const res = await loader({ request: fromInvite() });

    expect(mocks.addUser).not.toHaveBeenCalled();
    expect(mocks.consumeInvite).toHaveBeenCalledWith("abc123", "user_alice");
    expect(res.headers.get("Location")).toBe("/workspaces/torre");
  });

  it("leaves someone whose invite can't be accepted any more on the invite page, which says why", async () => {
    mocks.findUserByGitHubLogin.mockResolvedValue({ id: "user_alice" });
    mocks.findInvite.mockResolvedValue(invite({ status: "consumed" }));

    const res = await loader({ request: fromInvite() });

    expect(mocks.consumeInvite).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/invite/abc123");
  });
});
