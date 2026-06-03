// Real-database exercise of the Señor Doco agent loop (`runAssistantTurn`).
//
// Points `@doco/db`'s `withClient` at an in-process PGlite loaded with the
// REAL schema, so the loop's persistence (chat_messages, the active-turn
// replay buffer, conversation bookkeeping) runs against actual Postgres
// semantics. The ONLY stubbed boundary is the Anthropic model call
// (`streamSenorDocoMessage`) — scripted per turn — plus the doco_api tool
// executor. This is the characterization net the loop never had: it pins
// the observable event stream + persisted rows for the two shapes that
// matter (text-only finish, and a tool-use turn followed by text), so the
// upcoming extraction of a shared driver can be proven behavior-preserving.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
const runtime = vi.hoisted(() => ({ stream: vi.fn() }));
const tool = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
  listWorkspacesForUser: async () => [],
}));
vi.mock("../assistant-runtime.server", () => ({
  SENOR_DOCO_DEFAULT_MAX_TOKENS: 8192,
  getSenorDocoModel: () => "claude-test",
  missingSenorDocoAnthropicMessage: () => null,
  streamSenorDocoMessage: runtime.stream,
}));
vi.mock("../doco-api-tool.server", () => ({
  DOCO_API_TOOL: {
    name: "doco_api",
    description: "Call a Doco API route",
    input_schema: { type: "object", properties: {} },
  },
  runDocoApiToolRequest: tool.run,
}));
vi.mock("../senor-doco-prompt.server", () => ({ buildSenorDocoCorePrompt: () => "SYSTEM PROMPT" }));
vi.mock("../host.server", () => ({ listAllDocos: async () => [] }));
vi.mock("../doco-access.server", () => ({ canAccessDoco: async () => true }));
vi.mock("../internal-fetch.server", () => ({ internalFetch: vi.fn(async () => null) }));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));
vi.mock("../telemetry.server", () => ({ upsertAgentTurn: vi.fn(async () => {}) }));

import { runAssistantTurn } from "../agent-chat.server";
import type { ChatConversationRow, ChatStreamContext } from "../agent-chat.server";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

// Minimal stand-in for Anthropic's MessageStream: async-iterable of the
// streaming events the loop consumes, plus finalMessage()/withResponse().
function makeStream(content: Block[], stopReason: string) {
  const final = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
      for (const b of content) {
        if (b.type === "text") {
          yield { type: "content_block_start", content_block: { type: "text", text: "" } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: b.text } };
          yield { type: "content_block_stop" };
        } else {
          yield {
            type: "content_block_start",
            content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
          };
          yield {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
          };
          yield { type: "content_block_stop" };
        }
      }
    },
    finalMessage: async () => final,
    withResponse: async () => ({ response: { headers: new Headers() }, request_id: "req_test" }),
  };
}

const USER = "user_loop00000000000000000000";
const CONV = "conv_loop00000000000000000000";

async function seed(): Promise<void> {
  const db = dbm.db;
  await db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
  await db.query("INSERT INTO chat_conversations (id, user_id) VALUES ($1,$2)", [CONV, USER]);
}

function conversation(): ChatConversationRow {
  return {
    id: CONV,
    user_id: USER,
    archived: false,
    title: null,
    attached_doco_ids: [],
    attached_workspace_handles: [],
    created_at: new Date(),
    updated_at: new Date(),
    active_turn_started_at: null,
  };
}

function ctx(): ChatStreamContext {
  return {
    origin: "https://doco.local",
    cookieHeader: "",
    principal: { id: USER, username: "loop-tester", type: "person", isHuman: true },
    currentPath: "/dashboard",
    attachmentIds: [],
    graphReferences: [],
    conversationId: CONV,
  };
}

async function drain(userText: string): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const ev of runAssistantTurn({ conversation: conversation(), userText, ctx: ctx() })) {
    events.push(ev as Record<string, unknown>);
  }
  return events;
}

async function persistedMessages(): Promise<Array<{ role: string; content: unknown }>> {
  const r = await dbm.db.query<{ role: string; content: unknown }>(
    "SELECT role, content FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at, id",
    [CONV],
  );
  return r.rows;
}

describe("agent loop against a real database", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    await dbm.db.exec(schemaSql);
    await seed();
    runtime.stream.mockReset();
    tool.run.mockReset();
    tool.run.mockImplementation(async ({ toolUseId }: { toolUseId: string }) => ({
      ok: true,
      preview: "doco_api 200",
      result: { type: "tool_result", tool_use_id: toolUseId, content: '{"ok":true}' },
    }));
  });

  it("streams text and persists the user + assistant turn for a no-tool reply", async () => {
    runtime.stream.mockReturnValueOnce(
      makeStream([{ type: "text", text: "Here is your answer." }], "end_turn"),
    );

    const events = await drain("How many nodes?");
    const kinds = events.map((e) => e.kind);

    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("done");
    expect(events.some((e) => e.kind === "text_delta" && e.text === "Here is your answer.")).toBe(
      true,
    );
    // Exactly one model call — no tool round trip.
    expect(runtime.stream).toHaveBeenCalledTimes(1);

    const messages = await persistedMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs a tool turn, then a text turn, persisting the full tool_use/tool_result pair", async () => {
    runtime.stream
      .mockReturnValueOnce(
        makeStream(
          [
            { type: "text", text: "Asserting it now:" },
            { type: "tool_use", id: "toolu_1", name: "doco_api", input: { method: "PATCH" } },
          ],
          "tool_use",
        ),
      )
      .mockReturnValueOnce(makeStream([{ type: "text", text: "Done — asserted." }], "end_turn"));

    const events = await drain("assert node 5");
    const kinds = events.map((e) => e.kind);

    // The loop surfaced the tool call and its result, then finished.
    expect(kinds).toContain("tool_use_start");
    expect(kinds).toContain("tool_use_result");
    expect(kinds.filter((k) => k === "text_delta").length).toBeGreaterThanOrEqual(2);
    expect(kinds[kinds.length - 1]).toBe("done");
    expect(tool.run).toHaveBeenCalledTimes(1);
    expect(runtime.stream).toHaveBeenCalledTimes(2);

    // Persisted: user ask, assistant(text+tool_use), user(tool_result), assistant(text).
    const messages = await persistedMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const toolResultMsg = messages[2].content as Array<{ type: string; tool_use_id?: string }>;
    expect(toolResultMsg[0].type).toBe("tool_result");
    expect(toolResultMsg[0].tool_use_id).toBe("toolu_1");
  });
});
