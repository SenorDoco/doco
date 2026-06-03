import type { ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import {
  type AgentLoopEvent,
  type AgentLoopModelResult,
  type AgentLoopToolResult,
  runSenorDocoAgentLoop,
} from "../senor-doco-agent-loop.server";

function toolBlock(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "doco_api", input: { method: "PATCH" } } as ToolUseBlock;
}

// Scripts one model turn: yields a text delta, returns the given blocks.
function modelTurn(result: AgentLoopModelResult) {
  return async function* (): AsyncGenerator<AgentLoopEvent, AgentLoopModelResult> {
    const text = result.finalBlocks.find((b) => b.type === "text");
    if (text && "text" in text) yield { kind: "text_delta", text: text.text };
    return result;
  };
}

async function collect(
  gen: AsyncGenerator<AgentLoopEvent>,
): Promise<{ events: AgentLoopEvent[]; kinds: string[] }> {
  const events: AgentLoopEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return { events, kinds: events.map((e) => e.kind) };
}

const okTool = async (block: ToolUseBlock): Promise<AgentLoopToolResult> => ({
  ok: true,
  preview: "ok",
  result: { type: "tool_result", tool_use_id: block.id, content: "done" },
});

describe("runSenorDocoAgentLoop", () => {
  it("finishes after one no-tool turn", async () => {
    const messages: never[] = [];
    const calls: number[] = [];
    const { kinds } = await collect(
      runSenorDocoAgentLoop({
        messages,
        maxTurns: 10,
        callModel: (turn) => {
          calls.push(turn);
          return modelTurn({
            finalBlocks: [{ type: "text", text: "Answer." }],
            toolUseBlocks: [],
            stopReason: "end_turn",
          })();
        },
        runTool: okTool,
      }),
    );

    expect(calls).toEqual([0]);
    expect(kinds).toEqual(["text_delta", "assistant_message"]);
    // The driver stops after the final assistant_message; no turn_limit.
    expect(kinds).not.toContain("turn_limit");
  });

  it("runs a tool turn, feeds results back, then finishes", async () => {
    const messages: unknown[] = [];
    const turns: AgentLoopModelResult[] = [
      {
        finalBlocks: [
          { type: "text", text: "Working:" },
          toolBlock("toolu_1"),
        ],
        toolUseBlocks: [toolBlock("toolu_1")],
        stopReason: "tool_use",
      },
      {
        finalBlocks: [{ type: "text", text: "Done." }],
        toolUseBlocks: [],
        stopReason: "end_turn",
      },
    ];
    const { kinds } = await collect(
      runSenorDocoAgentLoop({
        messages: messages as never,
        maxTurns: 10,
        callModel: (turn) => modelTurn(turns[turn])(),
        runTool: okTool,
      }),
    );

    expect(kinds).toEqual([
      "text_delta",
      "tool_use_input",
      "assistant_message",
      "status", // running_tool
      "status", // tool_returned
      "tool_use_result",
      "tool_results",
      "text_delta",
      "assistant_message",
    ]);
    // assistant, tool_results(user), assistant — 3 appended messages.
    expect(messages).toHaveLength(3);
    expect((messages as { role: string }[]).map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("emits turn_limit when the model never settles", async () => {
    const messages: unknown[] = [];
    const { kinds } = await collect(
      runSenorDocoAgentLoop({
        messages: messages as never,
        maxTurns: 2,
        callModel: () =>
          modelTurn({
            finalBlocks: [toolBlock("toolu_x")],
            toolUseBlocks: [toolBlock("toolu_x")],
            stopReason: "tool_use",
          })(),
        runTool: okTool,
      }),
    );

    expect(kinds[kinds.length - 1]).toBe("turn_limit");
    expect(kinds.filter((k) => k === "assistant_message")).toHaveLength(2);
  });

  it("stops at the top of a turn when shouldAbort is true", async () => {
    let calls = 0;
    const { kinds } = await collect(
      runSenorDocoAgentLoop({
        messages: [],
        maxTurns: 10,
        callModel: () => {
          calls++;
          return modelTurn({
            finalBlocks: [{ type: "text", text: "x" }],
            toolUseBlocks: [],
            stopReason: "end_turn",
          })();
        },
        runTool: okTool,
        shouldAbort: async () => true,
      }),
    );

    expect(calls).toBe(0);
    expect(kinds).toEqual(["aborted"]);
  });
});
