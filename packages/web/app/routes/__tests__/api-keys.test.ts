import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  listApiKeysForUser: vi.fn(),
  mintApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/api-keys.server", () => ({
  listApiKeysForUser: mocks.listApiKeysForUser,
  mintApiKey: mocks.mintApiKey,
  revokeApiKey: mocks.revokeApiKey,
}));

import { action, loader } from "../api.v1.api-keys[.]json";

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://doco.test/api/v1/api-keys.json", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/v1/api-keys.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
  });

  it("lists keys for the signed-in user", async () => {
    mocks.listApiKeysForUser.mockResolvedValue([
      {
        client_id: "doco_client_1",
        client_name: "ci-pipeline",
        source: "personal",
        granted_at: "2026-01-01T00:00:00Z",
        last_used_at: null,
        expires_at: "2026-03-01T00:00:00Z",
        scope_grants: [],
      },
    ]);
    const response = await loader({
      request: jsonRequest(undefined, "GET"),
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      keys: [{ client_name: "ci-pipeline", source: "personal" }],
    });
    expect(mocks.listApiKeysForUser).toHaveBeenCalledWith("user_alice");
  });

  it("refuses anonymous reads", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    const response = await loader({
      request: jsonRequest(undefined, "GET"),
    } as never);
    expect(response.status).toBe(401);
  });

  it("mints a personal key when given a label + grants", async () => {
    mocks.mintApiKey.mockResolvedValue({
      access_token: "doco_at_test",
      refresh_token: "doco_rt_test",
      expires_in: 3600,
      client_name: "my-script",
      scope_grants: [
        {
          level: "doco",
          target_id: "doco_acme",
          target_label: "acme",
          target_link: "/acme",
          role: "owner",
        },
      ],
    });
    const response = await action({
      request: jsonRequest({
        label: "my-script",
        grants: [{ level: "doco", target_id: "doco_acme", role: "owner" }],
      }),
    } as never);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "doco_at_test",
      refresh_token: "doco_rt_test",
      token_type: "Bearer",
      client_name: "my-script",
    });
    expect(mocks.mintApiKey).toHaveBeenCalledWith({
      me: expect.objectContaining({ id: "user_alice" }),
      label: "my-script",
      grants: [{ level: "doco", target_id: "doco_acme", role: "owner" }],
      non_rotating: false,
    });
  });

  it("mints a non-rotating cloud token and returns client_id", async () => {
    mocks.mintApiKey.mockResolvedValue({
      access_token: "doco_at_test",
      refresh_token: "doco_rt_test",
      client_id: "doco_client_cloud",
      expires_in: 86400,
      client_name: "cloud-agent",
      scope_grants: [],
      non_rotating: true,
    });
    const response = await action({
      request: jsonRequest({
        label: "cloud-agent",
        grants: [{ level: "doco", target_id: "doco_acme", role: "owner" }],
        non_rotating: true,
      }),
    } as never);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client_id: "doco_client_cloud",
      non_rotating: true,
    });
    expect(mocks.mintApiKey).toHaveBeenCalledWith(expect.objectContaining({ non_rotating: true }));
  });

  it("rejects mint without a label", async () => {
    const response = await action({
      request: jsonRequest({ grants: [] }),
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "label_required" });
  });

  it("rejects mint with malformed grants", async () => {
    const response = await action({
      request: jsonRequest({ label: "x", grants: "nope" }),
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "grants_required" });
  });

  it("rejects mint with grant missing fields", async () => {
    const response = await action({
      request: jsonRequest({
        label: "x",
        grants: [{ level: "doco", target_id: "doco_acme" }],
      }),
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant_entry" });
  });

  it("returns 403 when role exceeds caller's own", async () => {
    mocks.mintApiKey.mockRejectedValue(
      new Error("Cannot grant 'owner' on a doco where you only hold 'writer'."),
    );
    const response = await action({
      request: jsonRequest({
        label: "x",
        grants: [{ level: "doco", target_id: "doco_acme", role: "owner" }],
      }),
    } as never);
    expect(response.status).toBe(403);
  });

  it("revokes a key by client_id", async () => {
    mocks.revokeApiKey.mockResolvedValue(true);
    const response = await action({
      request: new Request("https://doco.test/api/v1/api-keys.json?client_id=doco_client_xyz", {
        method: "DELETE",
      }),
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(mocks.revokeApiKey).toHaveBeenCalledWith({
      user_id: "user_alice",
      client_id: "doco_client_xyz",
    });
  });

  it("rejects revoke without client_id", async () => {
    const response = await action({
      request: new Request("https://doco.test/api/v1/api-keys.json", { method: "DELETE" }),
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "client_id_required" });
  });
});
