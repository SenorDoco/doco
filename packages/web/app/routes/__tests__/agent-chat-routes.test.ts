import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  loadConversationByIdForPrincipal: vi.fn(),
  loadOrCreateConversation: vi.fn(),
  mutateConversationAttachments: vi.fn(),
  patchConversation: vi.fn(),
  runAssistantTurn: vi.fn(),
  stopActiveTurnForPrincipal: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/agent-chat.server", () => ({
  loadConversationByIdForPrincipal: mocks.loadConversationByIdForPrincipal,
  loadOrCreateConversation: mocks.loadOrCreateConversation,
  mutateConversationAttachments: mocks.mutateConversationAttachments,
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
    attached_doco_ids: [],
    attached_org_handles: [],
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
});
