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
  // The bootstrap step now reads the workspace constitution set; this turn
  // loop has no workspaces, so empty is correct.
  listAllDocos: async () => [],
  getWorkspaceConstitutionsByIds: async () => [],
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

import { TURN_TIME_BUDGET_MS, runAssistantTurn } from "../agent-chat.server";
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
    workspace_id: null,
    doco_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    active_turn_started_at: null,
  };
}

function ctx(now?: () => number): ChatStreamContext {
  return {
    origin: "https://doco.local",
    cookieHeader: "",
    principal: { id: USER, username: "loop-tester", type: "person", isHuman: true },
    currentPath: "/dashboard",
    attachmentIds: [],
    graphReferences: [],
    conversationId: CONV,
    now,
  };
}

async function drain(
  userText: string,
  now?: () => number,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const ev of runAssistantTurn({
    conversation: conversation(),
    userText,
    ctx: ctx(now),
  })) {
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

  // Regression: a second message arriving mid-tool must not make the next
  // turn re-run the first instruction. When the interrupt lands after a
  // write tool's side effect has committed, that work has to be recorded
  // (assistant tool_use + tool_result) so the next turn's history and
  // operation-memory reflect it. Before the fix the loop aborted in the
  // gap between the write and recording it, leaving the transcript showing
  // the instruction as un-acted-upon — so the model created "Señor Doco" a
  // second time instead of acting on the second message.
  it("persists committed tool work when a second message interrupts mid-tool", async () => {
    runtime.stream.mockReturnValueOnce(
      makeStream(
        [
          { type: "text", text: "Adding Señor Doco:" },
          {
            type: "tool_use",
            id: "toolu_create",
            name: "doco_api",
            input: { method: "POST", path: "/acme/api/principals.json" },
          },
        ],
        "tool_use",
      ),
    );
    // The write commits the instant runTool returns. Simulate the
    // interrupting second message by clearing the active-turn marker right
    // after the side effect — exactly what stopActiveTurnForPrincipal does
    // when the next POST /messages.json arrives while this turn is in flight.
    tool.run.mockImplementationOnce(async ({ toolUseId }: { toolUseId: string }) => {
      await dbm.db.query(
        "UPDATE chat_conversations SET active_turn_started_at = NULL WHERE id = $1",
        [CONV],
      );
      return {
        ok: true,
        preview: "doco_api 201",
        result: {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: '{"ok":true,"id":"principal_senordoco"}',
        },
      };
    });

    const events = await drain("Senor Doco reports to Alexander.");
    const kinds = events.map((e) => e.kind);

    // The turn was interrupted — it surfaced the stop and did NOT finish
    // normally, and made only the single model call (no continuation).
    expect(kinds).toContain("error");
    expect(kinds).not.toContain("done");
    expect(runtime.stream).toHaveBeenCalledTimes(1);

    // ...but the committed work is durable in the transcript: the user ask,
    // the assistant's tool_use, AND its tool_result were all persisted.
    const messages = await persistedMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistant = messages[1].content as Array<{ type: string; name?: string }>;
    expect(assistant.some((b) => b.type === "tool_use" && b.name === "doco_api")).toBe(true);
    const toolResult = messages[2].content as Array<{ type: string; tool_use_id?: string }>;
    expect(toolResult[0].type).toBe("tool_result");
    expect(toolResult[0].tool_use_id).toBe("toolu_create");
  });

  // The reported bug: on a long job the streaming lambda hit its serverless
  // `maxDuration` and was hard-killed mid-tool-call, so Señor Doco "just
  // stopped" with no explanation and an unfinished job. The loop now pauses
  // itself before the kill, persisting a resumable "send continue" note.
  it("pauses with a resumable 'continue' message when the per-reply time budget is exceeded", async () => {
    let toolCounter = 0;
    let nowMs = 1_000_000;
    // The model keeps asking for tools forever; only the wall-clock budget
    // can stop the loop. Each model call "consumes" the whole budget, so the
    // loop's next top-of-turn check crosses the deadline and pauses.
    runtime.stream.mockImplementation(() => {
      nowMs += TURN_TIME_BUDGET_MS;
      return makeStream(
        [
          {
            type: "tool_use",
            id: `toolu_${++toolCounter}`,
            name: "doco_api",
            input: { method: "POST" },
          },
        ],
        "tool_use",
      );
    });

    const events = await drain("import the whole BPM", () => nowMs);
    const kinds = events.map((e) => e.kind);

    // One tool turn ran, then the loop paused on the deadline — a clean
    // finish (`done`), NOT a silent stop, and nowhere near the 100-call cap.
    expect(runtime.stream).toHaveBeenCalledTimes(1);
    expect(kinds[kinds.length - 1]).toBe("done");

    // The pause is surfaced as a resumable, time-specific message — the
    // "time limit" variant, not the turn-cap ("Anthropic calls") one.
    const streamedText = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => e.text as string)
      .join("");
    expect(streamedText).toMatch(/continue/i);
    expect(streamedText).toMatch(/time limit/i);
    expect(streamedText).not.toMatch(/Anthropic calls/i);

    // ...and persisted, so a page refresh shows the note: user ask →
    // assistant tool_use → tool_result → the assistant pause message.
    const messages = await persistedMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(messages[messages.length - 1].content)).toMatch(/continue/i);
  });
});
