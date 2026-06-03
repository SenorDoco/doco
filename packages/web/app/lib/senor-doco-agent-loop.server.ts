// The shared Señor Doco agent loop.
//
// Both surfaces — the website (`streamAssistantTurn`) and the Slack bot
// (`generateSlackDocoLlmAnswer`) — drive the same multi-turn tool loop:
// call the model, surface its text + tool calls, run the tools, feed the
// results back, repeat until the model stops without a tool call (or a
// turn cap is hit). That control flow used to be hand-written twice and
// could drift. It now lives here once.
//
// Everything that genuinely differs per surface is injected:
//   - `callModel`  — how a single model turn is produced. The website
//     streams (and folds in telemetry); Slack does one batched call.
//     It yields passthrough events and returns the turn's blocks.
//   - `runTool`    — how a doco_api tool call executes. The website runs
//     as the session user; Slack runs as the linked user, role-capped.
//   - `shouldAbort`— optional mid-turn cancellation (website only).
//
// The driver owns only the loop: ordering, the stop decision, assembling
// tool_results into the next message, and the turn cap. It emits a
// normalized event stream; each surface renders it its own way (the
// website streams to the browser, Slack collapses it to one message).

import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";

export type AgentLoopEvent =
  // Passthrough from the model turn.
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; tool_use_id: string; name: string }
  | { kind: "tool_use_input"; tool_use_id: string; input: unknown }
  | { kind: "tool_use_result"; tool_use_id: string; ok: boolean; preview: string }
  | { kind: "navigate"; url: string }
  | { kind: "status"; phase: string; detail?: string }
  | {
      kind: "usage";
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }
  // A hard failure surfaced by callModel (e.g. a non-retryable Anthropic
  // error). The consumer renders it; the loop is over.
  | { kind: "error"; message: string }
  // Structural markers the consumer reacts to (persist / capture / finish).
  | { kind: "assistant_message"; blocks: ContentBlockParam[]; stopReason: string | null }
  | { kind: "tool_results"; blocks: ToolResultBlockParam[] }
  | { kind: "turn_limit" }
  | { kind: "aborted" };

export interface AgentLoopModelResult {
  /** The assistant turn's text + tool_use blocks, in order. */
  finalBlocks: ContentBlockParam[];
  /** Just the tool_use blocks (a subset of finalBlocks), for the tool phase. */
  toolUseBlocks: ToolUseBlock[];
  stopReason: string | null;
  /** Set when the turn was cancelled mid-stream; the loop exits at once. */
  aborted?: boolean;
}

export interface AgentLoopToolResult {
  ok: boolean;
  preview: string;
  result: ToolResultBlockParam;
  navigateUrl?: string;
}

export interface AgentLoopDeps {
  /**
   * Seeded conversation history. The driver appends the assistant turn and
   * the tool_results user turn as it goes, so a caller that makes a
   * follow-up model call after the loop (e.g. Slack's turn-limit wrap-up)
   * sees the full context.
   */
  messages: MessageParam[];
  maxTurns: number;
  callModel: (turn: number) => AsyncGenerator<AgentLoopEvent, AgentLoopModelResult>;
  runTool: (block: ToolUseBlock) => Promise<AgentLoopToolResult>;
  shouldAbort?: (opts?: { force?: boolean }) => Promise<boolean>;
}

export async function* runSenorDocoAgentLoop(deps: AgentLoopDeps): AsyncGenerator<AgentLoopEvent> {
  for (let turn = 0; turn < deps.maxTurns; turn++) {
    if (await deps.shouldAbort?.()) {
      yield { kind: "aborted" };
      return;
    }

    const result = yield* deps.callModel(turn);
    if (result.aborted) return;

    // Show what the model is about to do before we run anything.
    for (const block of result.toolUseBlocks) {
      yield { kind: "tool_use_input", tool_use_id: block.id, input: block.input };
    }
    yield { kind: "assistant_message", blocks: result.finalBlocks, stopReason: result.stopReason };
    deps.messages.push({ role: "assistant", content: result.finalBlocks });

    // No tool call → this turn is the final answer. The consumer finishes.
    if (result.stopReason !== "tool_use") return;

    const toolResults: ToolResultBlockParam[] = [];
    for (const block of result.toolUseBlocks) {
      if (await deps.shouldAbort?.({ force: true })) {
        yield { kind: "aborted" };
        return;
      }
      yield { kind: "status", phase: "running_tool", detail: block.name };
      const startedAt = performance.now();
      const tr = await deps.runTool(block);
      if (await deps.shouldAbort?.({ force: true })) {
        yield { kind: "aborted" };
        return;
      }
      yield {
        kind: "status",
        phase: "tool_returned",
        detail: `${block.name} ${tr.ok ? "ok" : "err"} ${Math.round(performance.now() - startedAt)}ms`,
      };
      yield { kind: "tool_use_result", tool_use_id: block.id, ok: tr.ok, preview: tr.preview };
      if (tr.navigateUrl) yield { kind: "navigate", url: tr.navigateUrl };
      toolResults.push(tr.result);
    }

    // One user-role message carrying every tool_result (Anthropic contract).
    yield { kind: "tool_results", blocks: toolResults };
    deps.messages.push({ role: "user", content: toolResults });
  }

  // Ran out of turns without the model settling on a final answer.
  yield { kind: "turn_limit" };
}
