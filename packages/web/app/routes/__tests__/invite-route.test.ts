import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeInvite: vi.fn(),
  findInvite: vi.fn(),
  getUserById: vi.fn(),
  getCurrentPrincipal: vi.fn(),
  getDocoById: vi.fn(),
  query: vi.fn(),
  upsertDocoUser: vi.fn(),
  upsertWorkspaceUser: vi.fn(),
  withClient: vi.fn(),
  startOnboarding: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getUserById: mocks.getUserById,
  getDocoById: mocks.getDocoById,
  upsertDocoUser: mocks.upsertDocoUser,
  upsertWorkspaceUser: mocks.upsertWorkspaceUser,
  withClient: mocks.withClient,
}));

vi.mock("~/lib/db.server", () => ({
  rootDir: () => "/tmp/doco",
}));

vi.mock("~/lib/invite-store.server", () => ({
  InviteStore: {
    forDoco: () => ({
      consumeInvite: mocks.consumeInvite,
      findInvite: mocks.findInvite,
    }),
  },
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/onboarding.server", () => ({
  startOnboarding: mocks.startOnboarding,
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import InviteLanding, { action, loader } from "../invite.$code";

const WORKSPACE_INVITE = {
  kind: "invite",
  code: "invite_code",
  level: "workspace",
  workspace_id: "workspace_torre",
  grants: [
    {
      level: "workspace",
      target_id: "workspace_torre",
      role: "writer",
      write_types: ["*"],
    },
  ],
  minted_by_user_id: "user_owner",
  role: "writer",
  expires_at: "2026-06-01T00:00:00.000Z",
  issued_at: "2026-05-30T00:00:00.000Z",
  status: "pending",
  redeemed_by_user_id: null,
  redeemed_at: null,
};

function request(method = "GET"): Request {
  return new Request("https://doco.test/invite/invite_code", { method });
}

describe("/invite/:code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
    mocks.getUserById.mockResolvedValue({
      id: "user_owner",
      github_login: "owner",
    });
    mocks.findInvite.mockResolvedValue(WORKSPACE_INVITE);
    mocks.consumeInvite.mockResolvedValue({
      ...WORKSPACE_INVITE,
      status: "consumed",
      redeemed_by_user_id: "user_alice",
      redeemed_at: "2026-05-30T01:00:00.000Z",
    });
    mocks.query.mockResolvedValue({
      rows: [{ id: "workspace_torre", handle: "torre" }],
    });
    mocks.withClient.mockImplementation((callback) => callback({ query: mocks.query }));
  });

  it("loads workspace-only invites without a doco anchor", async () => {
    const result = await loader({
      request: request(),
      params: { code: "invite_code" },
    });

    expect(result).toMatchObject({
      ok: true,
      target: { level: "workspace", label: "torre" },
      inviter: { username: "owner" },
      signedIn: { username: "alice" },
    });
    expect(mocks.getDocoById).not.toHaveBeenCalled();
  });

  it("accepts workspace-only invites by granting workspace membership", async () => {
    await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });

    expect(mocks.upsertWorkspaceUser).toHaveBeenCalledWith({
      workspace_id: "workspace_torre",
      user_id: "user_alice",
      role: "writer",
      write_types: ["*"],
    });
    expect(mocks.upsertDocoUser).not.toHaveBeenCalled();
  });

  it("upgrades legacy writer invites with empty write_types to write-all", async () => {
    const legacyInvite = {
      ...WORKSPACE_INVITE,
      grants: [
        {
          level: "workspace",
          target_id: "workspace_torre",
          role: "writer",
          write_types: [],
        },
      ],
    };
    mocks.findInvite.mockResolvedValue(legacyInvite);
    mocks.consumeInvite.mockResolvedValue({
      ...legacyInvite,
      status: "consumed",
      redeemed_by_user_id: "user_alice",
      redeemed_at: "2026-05-30T01:00:00.000Z",
    });

    await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });

    expect(mocks.upsertWorkspaceUser).toHaveBeenCalledWith({
      workspace_id: "workspace_torre",
      user_id: "user_alice",
      role: "writer",
      write_types: ["*"],
    });
  });

  // Alexander, 2026-10-01: someone who joins a workspace from an invite has
  // one thing to do, ask their agent to start using Doco, and the workspace
  // keeps them on it until it's done.
  it("starts the workspace's agent step for the new member and takes them there", async () => {
    const result = await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });
    expect(mocks.startOnboarding).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "workspace_torre",
      userId: "user_alice",
      joinedAs: "invitee",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/workspaces/torre");
  });

  it("shows a Doco invite's new member the way on to the Doco, with no workspace steps", async () => {
    const docoInvite = {
      ...WORKSPACE_INVITE,
      level: "doco",
      grants: [{ level: "doco", target_id: "doco_bugs", role: "writer", write_types: ["*"] }],
    };
    mocks.findInvite.mockResolvedValue(docoInvite);
    mocks.consumeInvite.mockResolvedValue({ ...docoInvite, status: "consumed" });
    mocks.getDocoById.mockResolvedValue({ id: "doco_bugs", handle: "torre-bugs" });
    const result = await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });
    expect(result).toMatchObject({ ok: true, continue_to: "/torre-bugs" });
    expect(mocks.startOnboarding).not.toHaveBeenCalled();

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(InviteLanding, {
          loaderData: { error: "consumed" },
          actionData: result as never,
        }),
      ),
    );
    expect(html).toContain("You&#x27;re in");
    expect(html).toContain('href="/torre-bugs"');
  });
});

describe("invite page", () => {
  // Alexander, 2026-10-01: the invite page explains Doco with the same block
  // as the home page, under the invite.
  it("explains how Doco works under the invite", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(InviteLanding, {
          loaderData: {
            ok: true,
            code: "invite_code",
            target: { level: "workspace", label: "acme" },
            inviter: { username: "ana" },
            expires_at: "2026-10-08T15:00:00.000Z",
            signedIn: null,
          },
        }),
      ),
    );
    expect(html).not.toContain("Doco keeps people, agents, and work aligned.");
    expect(html.indexOf("How Doco works")).toBeGreaterThan(html.indexOf("Who is redeeming"));
  });
});
