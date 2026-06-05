import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getOrCreateDocoConversationForPrincipal: vi.fn(),
  loadConversationByIdForPrincipal: vi.fn(),
  loadOrCreateConversation: vi.fn(),
  patchConversation: vi.fn(),
  runAssistantTurn: vi.fn(),
  stopActiveTurnForPrincipal: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/agent-chat.server", () => ({
  getOrCreateDocoConversationForPrincipal: mocks.getOrCreateDocoConversationForPrincipal,
  loadConversationByIdForPrincipal: mocks.loadConversationByIdForPrincipal,
  loadOrCreateConversation: mocks.loadOrCreateConversation,
  patchConversation: mocks.patchConversation,
  runAssistantTurn: mocks.runAssistantTurn,
  stopActiveTurnForPrincipal: mocks.stopActiveTurnForPrincipal,
}));

import { action as patchConversationAction } from "../api.v1.agent-chat.conversation.$id[.]json";
import { action as postMessageAction } from "../api.v1.agent-chat.messages[.]json";

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: "doco_session=test" },
    body: JSON.stringify(body),
  });
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv_1",
    user_id: "user_alice",
    archived: false,
    title: "Ask",
    workspace_id: null,
    doco_id: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    active_turn_started_at: null,
    ...overrides,
  };
}

describe("agent chat routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "user_alice",
      username: "alice",
      type: "person",
      isHuman: true,
    });
    mocks.runAssistantTurn.mockImplementation(async function* () {
      yield { kind: "done" };
    });
  });

  it("stops the active turn and starts a fresh ask when a new message arrives", async () => {
    mocks.loadConversationByIdForPrincipal.mockResolvedValue(
      conversationRow({ active_turn_started_at: new Date("2026-01-01T00:00:05Z") }),
    );
    mocks.stopActiveTurnForPrincipal.mockResolvedValue({
      row: conversationRow({ active_turn_started_at: null }),
      stopped: true,
    });

    const response = await postMessageAction({
      request: jsonRequest("https://doco.test/api/v1/agent-chat/messages.json", {
        text: "One more thing",
        conversation_id: "conv_1",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.stopActiveTurnForPrincipal).toHaveBeenCalledWith("conv_1", "user_alice");
    expect(mocks.runAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          id: "conv_1",
          active_turn_started_at: null,
        }),
        userText: "One more thing",
      }),
    );
  });

  it("lazily opens the Doco's chat when a first message carries doco_id", async () => {
    mocks.getOrCreateDocoConversationForPrincipal.mockResolvedValue(
      conversationRow({ id: "conv_doco", doco_id: "doco_billing" }),
    );

    const response = await postMessageAction({
      request: jsonRequest("https://doco.test/api/v1/agent-chat/messages.json", {
        text: "What changed here?",
        doco_id: "doco_billing",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getOrCreateDocoConversationForPrincipal).toHaveBeenCalledWith(
      "user_alice",
      "doco_billing",
    );
    // No conversation_id → it must not fall back to the rolling active thread.
    expect(mocks.loadOrCreateConversation).not.toHaveBeenCalled();
    expect(mocks.runAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: "conv_doco", doco_id: "doco_billing" }),
        userText: "What changed here?",
      }),
    );
  });

  it("404s when doco_id names a Doco the user can't reach", async () => {
    mocks.getOrCreateDocoConversationForPrincipal.mockResolvedValue(null);

    const response = await postMessageAction({
      request: jsonRequest("https://doco.test/api/v1/agent-chat/messages.json", {
        text: "let me in",
        doco_id: "doco_secret",
      }),
    });

    expect(response.status).toBe(404);
    expect(mocks.runAssistantTurn).not.toHaveBeenCalled();
  });

  it("lets the owner of a thread request that its active turn stop", async () => {
    mocks.stopActiveTurnForPrincipal.mockResolvedValue({
      row: conversationRow({ active_turn_started_at: null }),
      stopped: true,
    });

    const response = await patchConversationAction({
      request: jsonRequest(
        "https://doco.test/api/v1/agent-chat/conversation/conv_1.json",
        { stop_active_turn: true },
        "PATCH",
      ),
      params: { id: "conv_1" },
    });

    expect(response.status).toBe(200);
    expect(mocks.stopActiveTurnForPrincipal).toHaveBeenCalledWith("conv_1", "user_alice");
    await expect(response.json()).resolves.toMatchObject({
      stopped_active_turn: true,
      conversation: {
        id: "conv_1",
        active_turn_started_at: null,
      },
    });
  });

  it("no longer attaches docos to a thread — legacy attach fields are ignored", async () => {
    mocks.patchConversation.mockResolvedValue(conversationRow());

    const response = await patchConversationAction({
      request: jsonRequest(
        "https://doco.test/api/v1/agent-chat/conversation/conv_1.json",
        { attach_doco_id: "doco_x", detach_workspace: "acme" },
        "PATCH",
      ),
      params: { id: "conv_1" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversation: Record<string, unknown> };
    // A thread belongs to a workspace, not docos: the response carries no
    // attachment fields, and the legacy keys are simply dropped.
    expect(body.conversation).not.toHaveProperty("attached_doco_ids");
    expect(body.conversation).not.toHaveProperty("attached_workspace_handles");
  });
});
