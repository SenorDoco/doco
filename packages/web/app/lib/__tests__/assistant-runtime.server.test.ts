import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SENOR_DOCO_DEFAULT_MODEL,
  createSenorDocoMessage,
  getSenorDocoModel,
  streamSenorDocoMessage,
  stripEmptyTextBlocks,
} from "../assistant-runtime.server";

// The model occasionally emits a zero-length text block before a tool_use;
// once that block is fed back into `messages` (within the same loop, or
// re-loaded from persisted history on a later turn) the Anthropic API
// rejects the whole request with 400 "text content blocks must be
// non-empty". The runtime boundary every Señor Doco call passes through
// strips those blocks so neither a live turn nor an already-broken thread
// 400s. These mocks let us assert what actually reaches the SDK.
const sdk = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: sdk.create, stream: sdk.stream };
  },
}));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));

const originalModel = process.env.SENOR_DOCO_ANTHROPIC_MODEL;
const originalFallbackModel = process.env.DOCO_ASSISTANT_MODEL;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

describe("assistant-runtime.server", () => {
  afterEach(() => {
    restoreEnv("SENOR_DOCO_ANTHROPIC_MODEL", originalModel);
    restoreEnv("DOCO_ASSISTANT_MODEL", originalFallbackModel);
    restoreEnv("ANTHROPIC_API_KEY", originalApiKey);
  });

  it("defaults Señor Doco to Sonnet — capable in-product assistant, MCP-for-complex", () => {
    // Señor Doco is positioned as the in-product Sonnet assistant for simple
    // work; complex work is delegated to a user's own agent over the MCP.
    expect(SENOR_DOCO_DEFAULT_MODEL).toBe("claude-sonnet-4-6");
  });

  it("uses the shared Señor Doco model default", () => {
    process.env.SENOR_DOCO_ANTHROPIC_MODEL = "";
    process.env.DOCO_ASSISTANT_MODEL = "";

    expect(getSenorDocoModel()).toBe(SENOR_DOCO_DEFAULT_MODEL);
  });

  it("lets all Señor Doco surfaces share one model override", () => {
    process.env.SENOR_DOCO_ANTHROPIC_MODEL = "claude-test-shared";
    process.env.DOCO_ASSISTANT_MODEL = "claude-test-fallback";

    expect(getSenorDocoModel()).toBe("claude-test-shared");
  });
});

describe("stripEmptyTextBlocks", () => {
  it("drops a zero-length text block but keeps the tool_use beside it", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool_use", id: "toolu_1", name: "doco_api", input: {} },
        ],
      },
    ];
    expect(stripEmptyTextBlocks(messages)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "doco_api", input: {} }],
      },
    ]);
  });

  it("drops whitespace-only text blocks too", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "   \n\n" },
          { type: "text", text: "ok" },
        ],
      },
    ];
    expect(stripEmptyTextBlocks(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
  });

  it("keeps non-empty text, tool_result, and plain string content untouched", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    expect(stripEmptyTextBlocks(messages)).toEqual(messages);
  });

  it("drops a message left empty after filtering so the request stays valid", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "ask" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "user", content: "again" },
    ];
    expect(stripEmptyTextBlocks(messages)).toEqual([
      { role: "user", content: "ask" },
      { role: "user", content: "again" },
    ]);
  });
});

describe("Señor Doco runtime sanitizes messages before the SDK call", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    sdk.create.mockReset();
    sdk.stream.mockReset();
    sdk.create.mockResolvedValue({ id: "msg_test" });
    sdk.stream.mockReturnValue({ id: "stream_test" });
  });

  const dirty: MessageParam[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "tool_use", id: "toolu_1", name: "doco_api", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
  ];

  it("createSenorDocoMessage forwards messages with no empty text block", async () => {
    await createSenorDocoMessage({ max_tokens: 16, messages: dirty });
    const sent = sdk.create.mock.calls[0][0].messages as MessageParam[];
    expect(hasEmptyTextBlock(sent)).toBe(false);
    expect(sent[0].content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "doco_api", input: {} },
    ]);
  });

  it("streamSenorDocoMessage forwards messages with no empty text block", () => {
    streamSenorDocoMessage({ max_tokens: 16, messages: dirty });
    const sent = sdk.stream.mock.calls[0][0].messages as MessageParam[];
    expect(hasEmptyTextBlock(sent)).toBe(false);
  });
});

function hasEmptyTextBlock(messages: MessageParam[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "text" && b.text.trim().length === 0),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  process.env[name] = value ?? "";
}
