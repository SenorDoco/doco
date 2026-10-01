// Creating a workspace starts its creator's steps and welcomes them by email.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addWorkspaceByHandle: vi.fn(),
  startOnboarding: vi.fn(),
  sendEmail: vi.fn(),
  waitUntil: vi.fn(),
  email: "alice@example.com" as string | null,
}));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) =>
    fn({ query: async () => ({ rows: [{ email: mocks.email }] }) }),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("../redeem.server", () => ({ addWorkspaceByHandle: mocks.addWorkspaceByHandle }));
vi.mock("../onboarding.server", () => ({ startOnboarding: mocks.startOnboarding }));
vi.mock("../email.server", () => ({
  emailBaseUrl: () => "https://doco.to",
  sendEmail: mocks.sendEmail,
}));

import { createWorkspace } from "../workspace-create.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.email = "alice@example.com";
  mocks.addWorkspaceByHandle.mockResolvedValue({ id: "workspace_acme", handle: "acme" });
  mocks.sendEmail.mockResolvedValue({ sent: true });
});

describe("createWorkspace", () => {
  it("starts the creator's steps and emails them a welcome linking to the workspace", async () => {
    expect(
      await createWorkspace({ handle: "acme", ownerUserId: "user_alice", autoSuffix: true }),
    ).toEqual({ id: "workspace_acme", handle: "acme" });
    expect(mocks.addWorkspaceByHandle).toHaveBeenCalledWith({
      handle: "acme",
      ownerUserId: "user_alice",
      autoSuffix: true,
    });
    expect(mocks.startOnboarding).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "workspace_acme",
      userId: "user_alice",
      joinedAs: "creator",
    });
    // Sent after the response, so a slow provider never holds up the page.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.to).toBe("alice@example.com");
    expect(email.subject).toBe("Welcome to acme on Doco");
    expect(email.text).toContain("https://doco.to/workspaces/acme");
  });

  it("sends nothing to someone without an email address", async () => {
    mocks.email = null;
    await createWorkspace({ handle: "acme", ownerUserId: "user_alice" });
    expect(mocks.startOnboarding).toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
