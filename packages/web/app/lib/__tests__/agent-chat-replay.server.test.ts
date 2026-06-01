import { describe, expect, it, vi } from "vitest";
import {
  type ChatMessageRow,
  MAX_REPLAY_MESSAGES,
  buildDocoCreationContractPrompt,
  buildOperationMemoryFromRows,
  trimHistoryToWindow,
} from "../agent-chat.server";

vi.mock("@doco/db", () => ({
  listOrganizationsForUser: vi.fn(),
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
              org_id: "org_01",
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
              org_handle: "meta-doco",
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
});

describe("doco creation contract prompt", () => {
  it("teaches Señor Doco to ask before choosing an implied template", () => {
    const prompt = buildDocoCreationContractPrompt();

    expect(prompt).toContain("ask one short question");
    expect(prompt).toContain("Glossary doco");
    expect(prompt).toContain("glossaries");
    expect(prompt).toContain("A 201 response is authoritative");
  });
});
