import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  handleUserInviteAction: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/users.server", () => ({
  handleUserInviteAction: mocks.handleUserInviteAction,
}));

vi.mock("~/components/collaboration-invite-prompt", () => ({
  buildHumanInvitePrompt: (url: string) => `Open this URL: ${url}`,
}));

import { action } from "../api.v1.users.invite[.]json";

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://doco.test/api/v1/users/invite.json", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/v1/users/invite.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
  });

  it("refuses anonymous callers", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    const response = await action({
      request: jsonRequest({ level: "doco", target_id: "doco_acme" }),
    } as never);
    expect(response.status).toBe(401);
  });

  it("requires level", async () => {
    const response = await action({
      request: jsonRequest({ target_id: "doco_acme" }),
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "level_required" });
  });

  it("requires target_id", async () => {
    const response = await action({
      request: jsonRequest({ level: "doco" }),
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "target_id_required" });
  });

  it("returns invite URL + human prompt on success", async () => {
    mocks.handleUserInviteAction.mockResolvedValue({
      intent: "invite",
      ok: true,
      invite_url: "https://doco.test/invite/abc",
      doco_url: "https://doco.test/acme/",
      recipe_url: "https://doco.test/protocol/agent-oauth-recipe",
      device_url: "https://doco.test/device",
      invite_expires_at: "2026-06-01T00:00:00Z",
      level: "doco",
      role: "writer",
    });
    const response = await action({
      request: jsonRequest({ level: "doco", target_id: "doco_acme", role: "writer" }),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invite_url).toBe("https://doco.test/invite/abc");
    expect(body.level).toBe("doco");
    expect(body.role).toBe("writer");
    expect(body.prompt).toContain("https://doco.test/invite/abc");
  });

  it("returns 403 when caller tries to grant above their own role", async () => {
    mocks.handleUserInviteAction.mockResolvedValue({
      error: "Cannot mint a 'owner' invite -- you only hold 'writer' on this target.",
    });
    const response = await action({
      request: jsonRequest({ level: "doco", target_id: "doco_acme" }),
    } as never);
    expect(response.status).toBe(403);
  });

  it("rejects non-POST methods", async () => {
    const response = await action({
      request: jsonRequest(undefined, "GET"),
    } as never);
    expect(response.status).toBe(405);
  });
});
