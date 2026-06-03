// Wiring proof: POST /api/v1/docos.json (create a Doco) must refuse Señor
// Doco even when the underlying human is a workspace owner. Creating a Doco
// requires the workspace `owner` role; the route caps the agent's effective
// role with `capRoleForRequest`, so the agent falls below the gate while a
// real human owner still clears it. This is the create-doco half of "Señor
// Doco should never get owner access, neither on the web nor in Slack."

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Doco-creation seam — stubbed so we can assert whether the route
// reached creation, without touching Postgres or templates.
const created = vi.hoisted(() => vi.fn());

vi.mock("~/lib/redeem.server", () => ({ createDocoInWorkspace: created }));

// A signed-in human who genuinely owns the target workspace.
vi.mock("~/lib/session.server", async () => {
  const actual =
    await vi.importActual<typeof import("~/lib/session.server")>("~/lib/session.server");
  return {
    ...actual,
    getCurrentPrincipalAsync: vi.fn(async () => ({
      id: "user_owner",
      username: "owner",
      type: "person" as const,
      isHuman: true,
    })),
  };
});

// Real `roleAtLeast` (so the gate math is exercised), but `getWorkspaceRole`
// reports the human as a genuine owner.
vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, getWorkspaceRole: vi.fn(async () => "owner") };
});

import { action } from "~/routes/api.v1.docos[.]json";

function createRequest(headers: Record<string, string>): Request {
  return new Request("https://doco.test/api/v1/docos.json", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      workspace_id: "workspace_A",
      name: "demo",
      template_handle: "generic",
    }),
  });
}

beforeEach(() => {
  created.mockReset();
  created.mockResolvedValue({
    docoId: "doco_demo",
    handle: "demo",
    workspaceId: "workspace_A",
    workspaceHandle: "acme",
    goal: "",
  });
});

describe("POST /api/v1/docos.json — Señor Doco owner cap", () => {
  it("403s a Señor Doco (web) request and never reaches creation", async () => {
    const res = await action({
      request: createRequest({ "x-doco-authoring-surface": "senor-doco-web" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/owner/i);
    expect(created).not.toHaveBeenCalled();
  });

  it("403s a Señor Doco (Slack) request and never reaches creation", async () => {
    const res = await action({
      request: createRequest({ "x-doco-authoring-surface": "slack" }),
    });
    expect(res.status).toBe(403);
    expect(created).not.toHaveBeenCalled();
  });

  it("lets a human workspace owner through the gate and into creation", async () => {
    const res = await action({ request: createRequest({}) });
    expect(created).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
  });
});
