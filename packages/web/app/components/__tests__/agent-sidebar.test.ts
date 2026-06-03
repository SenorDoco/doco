import { describe, expect, it } from "vitest";

import { chatBubbleBlocks, mergeCreatedConversationListItem } from "../agent-sidebar";

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv_old",
    title: "Existing thread",
    archived: false,
    message_count: 1,
    updated_at: "2026-06-01T00:00:00.000Z",
    active_turn_started_at: null,
    last_message_preview: "Hello",
    last_message_role: "user" as const,
    attached_doco_ids: [],
    attached_workspace_handles: [],
    ...overrides,
  };
}

describe("mergeCreatedConversationListItem", () => {
  it("puts a newly-created thread at the top of the thread list", () => {
    const existing = conversation();
    const created = conversation({
      id: "conv_new",
      title: null,
      message_count: 0,
      last_message_preview: null,
      last_message_role: null,
      updated_at: "2026-06-01T00:01:00.000Z",
    });

    expect(mergeCreatedConversationListItem([existing], created)).toEqual([created, existing]);
  });

  it("replaces a duplicate created thread instead of showing it twice", () => {
    const staleCreated = conversation({
      id: "conv_new",
      title: "Old title",
    });
    const created = conversation({
      id: "conv_new",
      title: null,
      message_count: 0,
      last_message_preview: null,
      last_message_role: null,
    });

    expect(mergeCreatedConversationListItem([staleCreated], created)).toEqual([created]);
  });
});

describe("chatBubbleBlocks", () => {
  it("softens a tool-call preamble's dangling colon to an ellipsis", () => {
    expect(
      chatBubbleBlocks([
        { type: "text", text: "Let me update both fields with proper enumeration:" },
        { type: "tool_use", id: "t1", name: "doco_api", input: {} },
      ]),
    ).toEqual([{ type: "text", text: "Let me update both fields with proper enumeration…" }]);
  });

  it("drops tool_use and tool_result blocks", () => {
    expect(
      chatBubbleBlocks([
        { type: "text", text: "Done." },
        { type: "tool_use", id: "t1", name: "doco_api", input: {} },
        { type: "tool_result", tool_use_id: "t1", content: "{}" },
      ]),
    ).toEqual([{ type: "text", text: "Done." }]);
  });

  it("keeps a genuine trailing colon when no tool call follows it", () => {
    expect(chatBubbleBlocks([{ type: "text", text: "Here are the options:" }])).toEqual([
      { type: "text", text: "Here are the options:" },
    ]);
  });

  it("leaves a preamble without a trailing colon unchanged", () => {
    expect(
      chatBubbleBlocks([
        { type: "text", text: "Checking the graph." },
        { type: "tool_use", id: "t1", name: "doco_api", input: {} },
      ]),
    ).toEqual([{ type: "text", text: "Checking the graph." }]);
  });
});
