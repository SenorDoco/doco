import { describe, expect, it, vi } from "vitest";
import {
  type ChatMessageRow,
  MAX_REPLAY_MESSAGES,
  buildDocoCreationContractPrompt,
  buildOperationMemoryFromRows,
  coalesceAdjacentUserMessagesForAnthropic,
  evictedAttachmentNote,
  trimHistoryToWindow,
} from "../agent-chat.server";

vi.mock("@doco/db", () => ({
  listWorkspacesForUser: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("../assistant-runtime.server", () => ({
  SENOR_DOCO_DEFAULT_MAX_TOKENS: 8192,
  getSenorDocoModel: () => "claude-test",
  missingSenorDocoAnthropicMessage: () => null,
  streamSenorDocoMessage: vi.fn(),
}));

vi.mock("../dotenv.server", () => ({
  ensureEnvLoaded: vi.fn(),
}));

vi.mock("../telemetry.server", () => ({
  upsertAgentTurn: vi.fn(),
}));

function row(
  index: number,
  role: "user" | "assistant",
  content: ChatMessageRow["content"],
): ChatMessageRow {
  return {
    id: `msg_${index}`,
    conversation_id: "conv_1",
    role,
    content,
    created_at: new Date(`2026-01-01T00:${String(index).padStart(2, "0")}:00Z`),
  };
}

describe("conversation replay window", () => {
  it("keeps a broader replay window for tool-heavy conversations", () => {
    expect(MAX_REPLAY_MESSAGES).toBeGreaterThanOrEqual(120);
  });

  it("trims by approximate token budget from a clean user-text boundary", () => {
    const rows: ChatMessageRow[] = [
      row(0, "assistant", [{ type: "text", text: "orphaned assistant" }]),
      row(1, "user", [{ type: "text", text: "first clean turn" }]),
      row(2, "assistant", [{ type: "text", text: "x".repeat(200) }]),
      row(3, "user", [{ type: "text", text: "second clean turn" }]),
      row(4, "assistant", [{ type: "text", text: "brief" }]),
    ];

    const trimmed = trimHistoryToWindow(rows, { maxMessages: 10, maxApproxTokens: 50 });

    expect(trimmed.map((r) => r.id)).toEqual(["msg_3", "msg_4"]);
  });

  it("coalesces adjacent human asks left by an interrupted reply", () => {
    const messages = coalesceAdjacentUserMessagesForAnthropic([
      { role: "user", content: [{ type: "text", text: "First ask" }] },
      { role: "user", content: [{ type: "text", text: "Actually, include this too" }] },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(messages[0]?.content)).toContain("First ask");
    expect(JSON.stringify(messages[0]?.content)).toContain("Actually, include this too");
  });
});

describe("evictedAttachmentNote", () => {
  function attachment(id: string, filename: string): ChatMessageRow["content"][number] {
    return {
      type: "attachment_ref",
      attachment_id: id,
      filename,
      mime_type: "application/xml",
      size_bytes: 2048,
    } as ChatMessageRow["content"][number];
  }

  it("returns null when the attached file is still inside the window", () => {
    const full: ChatMessageRow[] = [
      row(0, "user", [attachment("att_1", "process.bpmn"), { type: "text", text: "here" }]),
    ];
    expect(evictedAttachmentNote(full, full)).toBeNull();
  });

  it("names a file whose message has been trimmed out of the window", () => {
    const full: ChatMessageRow[] = [
      row(0, "user", [attachment("att_1", "process.bpmn"), { type: "text", text: "the BPMN" }]),
      row(1, "user", [{ type: "text", text: "later turn" }]),
      row(2, "assistant", [{ type: "text", text: "ok" }]),
    ];
    const window = full.slice(1); // attachment's message evicted
    const note = evictedAttachmentNote(full, window);
    expect(note).toContain("process.bpmn");
    expect(note).toContain("re-attach");
  });

  it("does not flag a file that also appears within the window", () => {
    const full: ChatMessageRow[] = [
      row(0, "user", [attachment("att_1", "process.bpmn")]),
      row(1, "user", [{ type: "text", text: "filler" }]),
      row(2, "user", [attachment("att_1", "process.bpmn"), { type: "text", text: "re-sent" }]),
    ];
    const window = full.slice(2); // the re-sent copy is in-window
    expect(evictedAttachmentNote(full, window)).toBeNull();
  });
});

describe("operation memory", () => {
  it("pins successful doco creation tool results from the whole stored thread", () => {
    const rows: ChatMessageRow[] = [
      row(0, "user", [{ type: "text", text: "Create a Glossary Doco called meta-glossary." }]),
      row(1, "assistant", [
        {
          type: "tool_use",
          id: "toolu_create",
          name: "doco_api",
          input: {
            method: "POST",
            path: "/api/v1/docos.json",
            body: {
              name: "meta-glossary",
              workspace_id: "workspace_01",
              template_handle: "generic",
            },
          },
        },
      ]),
      row(2, "user", [
        {
          type: "tool_result",
          tool_use_id: "toolu_create",
          content: JSON.stringify({
            status: 201,
            ok: true,
            body: {
              id: "doco_01KT20KM0120ZXRVMX58K85YNF",
              handle: "meta-glossary",
              workspace_handle: "meta-doco",
              qualified_handle: "meta-doco/meta-glossary",
            },
          }),
        },
      ]),
    ];

    const memory = buildOperationMemoryFromRows(rows);

    expect(memory).toContain("Created doco meta-doco/meta-glossary");
    expect(memory).toContain("doco_01KT20KM0120ZXRVMX58K85YNF");
    expect(memory).toContain("POST /api/v1/docos.json -> 201");
    expect(memory).toContain("template_handle=generic");
    expect(memory).toContain("not that it pre-existed");
  });

  it("uses the response template handle when operation memory summarizes doco creation", () => {
    const rows: ChatMessageRow[] = [
      row(0, "user", [{ type: "text", text: "Create a process doco." }]),
      row(1, "assistant", [
        {
          type: "tool_use",
          id: "toolu_create",
          name: "doco_api",
          input: {
            method: "POST",
            path: "/api/v1/docos.json",
            body: {
              name: "flow",
              workspace_id: "workspace_01",
              template: "process",
            },
          },
        },
      ]),
      row(2, "user", [
        {
          type: "tool_result",
          tool_use_id: "toolu_create",
          content: JSON.stringify({
            status: 201,
            ok: true,
            body: {
              id: "doco_01KT20KM0120ZXRVMX58K85YNF",
              handle: "flow",
              workspace_handle: "meta-doco",
              qualified_handle: "meta-doco/flow",
              template_handle: "process",
            },
          }),
        },
      ]),
    ];

    const memory = buildOperationMemoryFromRows(rows);

    expect(memory).toContain("template_handle=process");
  });
});

describe("doco creation contract prompt", () => {
  it("teaches Señor Doco to ask before choosing an implied template", () => {
    const prompt = buildDocoCreationContractPrompt();

    expect(prompt).toContain("ask one short question");
    expect(prompt).toContain("business process doco");
    expect(prompt).toContain("process");
    expect(prompt).toContain("A 201 response is authoritative");
  });

  it("spells out the exact create-doco template field", () => {
    const prompt = buildDocoCreationContractPrompt();

    expect(prompt).toContain("template_handle");
    expect(prompt).toContain("Do not send `template`");
  });
});
