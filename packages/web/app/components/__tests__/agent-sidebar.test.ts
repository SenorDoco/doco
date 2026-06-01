import { describe, expect, it } from "vitest";

import { mergeCreatedConversationListItem } from "../agent-sidebar";

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
    attached_org_handles: [],
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
