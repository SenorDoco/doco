import { describe, expect, it } from "vitest";

import {
  chatBubbleBlocks,
  formatThreadUsageLabel,
  mergeCreatedConversationListItem,
} from "../agent-sidebar";

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

describe("formatThreadUsageLabel", () => {
  it("reads turns · headline tokens (input+output) · estimated cost", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 500,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 1,
        estimated_cost_usd: 0.0042,
      }),
    ).toBe("1 turn · 1.0k tokens · ~$0.0042");
  });

  it("pluralizes turns and rounds large token counts", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 120_000,
        output_tokens: 30_000,
        cache_read_tokens: 4_000_000,
        cache_creation_tokens: 0,
        turn_count: 3,
        estimated_cost_usd: 0.51,
      }),
    ).toBe("3 turns · 150k tokens · ~$0.5100");
  });

  it("shows two decimals for costs of a dollar or more", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 800_000,
        output_tokens: 40_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 9,
        estimated_cost_usd: 2.5,
      }),
    ).toBe("9 turns · 840k tokens · ~$2.50");
  });

  it("reads cleanly for a brand-new thread with no turns", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 0,
        estimated_cost_usd: 0,
      }),
    ).toBe("0 turns · 0 tokens · ~$0.00");
  });
});
