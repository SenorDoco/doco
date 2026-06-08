// Unit test for analyzeReplayWindow — the pure core that answers "did the file
// the user attached still reach the model on the next turn?". It must agree
// with the production trim (trimHistoryToWindow): an attachment is visible iff
// its message survives the message/token cap AND its bytes haven't been purged.

import { describe, expect, it } from "vitest";
import {
  type ChatMessageRow,
  MAX_REPLAY_MESSAGES,
  type PersistedContentBlock,
} from "../agent-chat.server";
import { analyzeReplayWindow } from "../agent-debug.server";

let seq = 0;
function msg(role: "user" | "assistant", content: PersistedContentBlock[]): ChatMessageRow {
  seq += 1;
  return {
    id: `msg_${String(seq).padStart(6, "0")}`,
    conversation_id: "conv_test",
    role,
    content,
    created_at: new Date(),
  };
}
function text(s: string): PersistedContentBlock {
  return { type: "text", text: s } as PersistedContentBlock;
}
function attachment(id: string, filename = "process.bpmn"): PersistedContentBlock {
  return {
    type: "attachment_ref",
    attachment_id: id,
    filename,
    mime_type: "application/xml",
    size_bytes: 1024,
  } as PersistedContentBlock;
}

describe("analyzeReplayWindow", () => {
  it("an attachment in the latest message is visible to the model", () => {
    const rows = [msg("user", [text("hi")]), msg("user", [attachment("att_recent"), text("here")])];
    const a = analyzeReplayWindow(rows, new Set());
    expect(a.attachments).toHaveLength(1);
    expect(a.attachments[0]).toMatchObject({
      attachment_id: "att_recent",
      in_replay_window: true,
      expired: false,
      visible_to_model: true,
    });
    expect(a.max_replay_messages).toBe(MAX_REPLAY_MESSAGES);
  });

  it("an attachment evicted by the message cap is not visible", () => {
    const rows: ChatMessageRow[] = [msg("user", [attachment("att_old"), text("the BPMN")])];
    // Bury it under far more than MAX_REPLAY_MESSAGES later messages.
    for (let i = 0; i < MAX_REPLAY_MESSAGES + 40; i++) {
      rows.push(msg(i % 2 === 0 ? "user" : "assistant", [text(`turn ${i}`)]));
    }
    const a = analyzeReplayWindow(rows, new Set());
    const old = a.attachments.find((x) => x.attachment_id === "att_old");
    expect(old?.in_replay_window).toBe(false);
    expect(old?.visible_to_model).toBe(false);
    expect(a.window_start_index).toBeGreaterThan(0);
  });

  it("an attachment evicted by the token cap (a big early message) is not visible", () => {
    const huge = "x".repeat(300_000); // ~75k approx tokens, over the ~64k cap
    const rows = [
      msg("user", [attachment("att_big"), text(huge)]),
      msg("user", [text("follow-up one")]),
      msg("assistant", [text("ok")]),
      msg("user", [text("follow-up two")]),
    ];
    const a = analyzeReplayWindow(rows, new Set());
    const big = a.attachments.find((x) => x.attachment_id === "att_big");
    expect(big?.in_replay_window).toBe(false);
    expect(big?.visible_to_model).toBe(false);
  });

  it("a purged attachment is not visible even while still in the window", () => {
    const rows = [msg("user", [attachment("att_gone"), text("recent but expired")])];
    const a = analyzeReplayWindow(rows, new Set(["att_gone"]));
    expect(a.attachments[0]).toMatchObject({
      in_replay_window: true,
      expired: true,
      visible_to_model: false,
    });
  });
});
