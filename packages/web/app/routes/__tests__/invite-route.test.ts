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
  loadOnboardingProgress: vi.fn(),
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
  loadOnboardingProgress: mocks.loadOnboardingProgress,
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
    mocks.loadOnboardingProgress.mockResolvedValue({
      workspace: true,
      agent: false,
      sources: false,
    });
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
    const result = await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });

    expect(result).toMatchObject({
      ok: true,
      continue_to: "/workspaces/torre",
      target_label: "torre",
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

  // A person who accepts an invite continues with the same steps as a person
  // who creates a workspace: the joined workspace finishes step one, and the
  // next step is connecting their agent.
  it("walks the new member on to connecting their agent after they accept", async () => {
    // VersionPill reads these vite-injected build-time globals during render.
    vi.stubGlobal("__DOCO_VERSION__", "0.0.0-test");
    vi.stubGlobal("__DOCO_RELEASE_AT__", "2026-01-01T00:00:00.000Z");
    const result = await action({
      request: request("POST"),
      params: { code: "invite_code" },
    });
    expect(result).toMatchObject({
      ok: true,
      onboarding: { workspace: true, agent: false, sources: false },
    });
    expect(mocks.loadOnboardingProgress).toHaveBeenCalledWith(expect.anything(), "user_alice");

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
    expect(html).toContain("Connect your agent");
    expect(html).toContain('href="/#instructions"');
    expect(html).toContain('href="/workspaces/torre"');
    vi.unstubAllGlobals();
  });
});
