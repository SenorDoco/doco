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
        finalBlocks: [{ type: "text", text: "Working:" }, toolBlock("toolu_1")],
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

  it("emits turn_limit reason 'turns' when the model never settles", async () => {
    const messages: unknown[] = [];
    const { kinds, events } = await collect(
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

    expect(events[events.length - 1]).toEqual({ kind: "turn_limit", reason: "turns" });
    expect(kinds.filter((k) => k === "assistant_message")).toHaveLength(2);
  });

  // The serverless function that streams a turn has a hard `maxDuration`.
  // A long job (importing a big BPM) makes dozens of model + tool
  // round-trips and blows past one invocation's limit — historically the
  // lambda was SIGKILLed mid-tool-call and the agent just stopped with no
  // explanation. The wall-clock budget makes the loop pause itself BEFORE
  // the kill: it stops at the top of a turn once the clock crosses the
  // budget, emitting turn_limit reason "time" — and the work already done
  // is preserved in `messages` so "continue" resumes from it. The budget,
  // not the (much larger) turn cap, is what binds here.
  it("stops with turn_limit reason 'time' once the wall-clock budget is exceeded", async () => {
    const messages: unknown[] = [];
    let calls = 0;
    let nowMs = 1_000;
    const { events } = await collect(
      runSenorDocoAgentLoop({
        messages: messages as never,
        maxTurns: 100, // far above what the time budget allows — it must NOT bind
        timeBudgetMs: 250,
        now: () => nowMs,
        callModel: () => {
          calls++;
          nowMs += 100; // each turn "consumes" 100ms of wall-clock
          return modelTurn({
            finalBlocks: [toolBlock(`toolu_${calls}`)],
            toolUseBlocks: [toolBlock(`toolu_${calls}`)],
            stopReason: "tool_use",
          })();
        },
        runTool: okTool,
      }),
    );

    // start=1000. Checks at elapsed 0,100,200 pass (3 model turns run);
    // at elapsed 300 ≥ 250 the loop pauses instead of calling the model again.
    expect(calls).toBe(3);
    expect(events[events.length - 1]).toEqual({ kind: "turn_limit", reason: "time" });
    // The completed turns' work survives the pause: each tool turn pushes an
    // assistant message and a tool_results user message (3 turns → 6 rows).
    expect(messages).toHaveLength(6);
  });

  // Progress guarantee: a budget that's already spent at loop entry must
  // still run one turn, or a resumed slice ("continue") would pause
  // immediately and never advance.
  it("always runs at least one turn even when the budget is already spent", async () => {
    let calls = 0;
    const { events } = await collect(
      runSenorDocoAgentLoop({
        messages: [],
        maxTurns: 100,
        timeBudgetMs: 250,
        now: () => 10_000, // constant clock: elapsed is always 0 < budget at turn 0
        callModel: () => {
          calls++;
          return modelTurn({
            finalBlocks: [{ type: "text", text: "Done." }],
            toolUseBlocks: [],
            stopReason: "end_turn",
          })();
        },
        runTool: okTool,
      }),
    );

    expect(calls).toBe(1);
    // Settled on a final answer — no budget pause.
    expect(events.some((e) => e.kind === "turn_limit")).toBe(false);
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

  // A tool's side effect (e.g. a doco_api write) is durable the instant
  // runTool returns. If the turn is then aborted — a newer message
  // superseding it — that completed work MUST still be recorded as an
  // assistant tool_use + tool_result, or the next turn loads a transcript
  // where the work looks undone and repeats it. (This is the "sent a
  // second message, it re-ran the first instruction" bug.)
  it("records completed tool work when aborted after a tool's side effect commits", async () => {
    const messages: unknown[] = [];
    let sideEffectCommitted = false;
    const { kinds, events } = await collect(
      runSenorDocoAgentLoop({
        messages: messages as never,
        maxTurns: 10,
        callModel: () =>
          modelTurn({
            finalBlocks: [{ type: "text", text: "Adding Señor Doco:" }, toolBlock("toolu_1")],
            toolUseBlocks: [toolBlock("toolu_1")],
            stopReason: "tool_use",
          })(),
        runTool: async (block) => {
          // The write lands the moment runTool returns.
          sideEffectCommitted = true;
          return {
            ok: true,
            preview: "created",
            result: { type: "tool_result", tool_use_id: block.id, content: "created" },
          };
        },
        // False at the top-of-loop and pre-tool checks; true only once the
        // tool has run and its side effect is committed.
        shouldAbort: async () => sideEffectCommitted,
      }),
    );

    // The turn was aborted...
    expect(kinds).toContain("aborted");
    // ...but the committed work was flushed first: a tool_results event
    // and the assistant + tool-result messages pushed into history.
    expect(kinds).toContain("tool_results");
    expect(kinds.indexOf("tool_results")).toBeLessThan(kinds.indexOf("aborted"));
    const toolResultsEv = events.find((e) => e.kind === "tool_results");
    expect(toolResultsEv && "blocks" in toolResultsEv ? toolResultsEv.blocks : []).toHaveLength(1);
    expect((messages as { role: string }[]).map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  // Anthropic requires every tool_use block to be answered by a matching
  // tool_result in the very next turn. When we abort mid-batch, synthesize
  // results for the tools we never reached so the persisted pair stays
  // balanced — otherwise the *next* turn's model call 400s.
  it("balances tool_results for un-run tools when aborted mid-batch", async () => {
    const messages: unknown[] = [];
    let toolRuns = 0;
    const { events } = await collect(
      runSenorDocoAgentLoop({
        messages: messages as never,
        maxTurns: 10,
        callModel: () =>
          modelTurn({
            finalBlocks: [toolBlock("toolu_1"), toolBlock("toolu_2")],
            toolUseBlocks: [toolBlock("toolu_1"), toolBlock("toolu_2")],
            stopReason: "tool_use",
          })(),
        runTool: async (block) => {
          toolRuns++;
          return {
            ok: true,
            preview: "ok",
            result: { type: "tool_result", tool_use_id: block.id, content: "ok" },
          };
        },
        // Abort the instant the first tool has committed; the second never runs.
        shouldAbort: async () => toolRuns >= 1,
      }),
    );

    expect(toolRuns).toBe(1);
    const ev = events.find((e) => e.kind === "tool_results");
    const ids =
      ev && "blocks" in ev ? ev.blocks.map((b) => (b as { tool_use_id: string }).tool_use_id) : [];
    // Both tool_use ids are answered — toolu_1 for real, toolu_2 synthesized.
    expect(ids).toEqual(["toolu_1", "toolu_2"]);
  });
});
