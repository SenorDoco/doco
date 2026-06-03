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
  // The loop hit a budget and paused without a final answer. `reason`
  // tells the consumer WHICH budget so it can word the "send continue"
  // prompt accurately: "turns" = the per-reply Anthropic-call cap;
  // "time" = the wall-clock budget that stops us BEFORE the serverless
  // function's maxDuration hard-kills the lambda mid-tool-call.
  | { kind: "turn_limit"; reason: "turns" | "time" }
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
  /**
   * Optional wall-clock budget for the whole loop, in milliseconds. When
   * set, the loop stops BEFORE starting another model turn once the
   * elapsed time crosses the budget, emitting `turn_limit` with reason
   * "time". This is the graceful counterpart to the serverless function's
   * `maxDuration`: long jobs (e.g. importing a big BPM) routinely run past
   * one invocation's hard limit, and without a soft budget Vercel SIGKILLs
   * the lambda mid-tool-call — the user just sees the agent stop with no
   * explanation. Each completed turn's work is already persisted by the
   * consumer, so pausing here and prompting "continue" resumes cleanly.
   * Mirrors the per-window time budget in github-backfill-driver.server.ts.
   * Omit it (Slack) to keep the loop bounded only by `maxTurns`.
   */
  timeBudgetMs?: number;
  /** Injectable clock for the time budget; defaults to `Date.now`. */
  now?: () => number;
  callModel: (turn: number) => AsyncGenerator<AgentLoopEvent, AgentLoopModelResult>;
  runTool: (block: ToolUseBlock) => Promise<AgentLoopToolResult>;
  shouldAbort?: (opts?: { force?: boolean }) => Promise<boolean>;
}

export async function* runSenorDocoAgentLoop(deps: AgentLoopDeps): AsyncGenerator<AgentLoopEvent> {
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  for (let turn = 0; turn < deps.maxTurns; turn++) {
    if (await deps.shouldAbort?.()) {
      yield { kind: "aborted" };
      return;
    }

    // Stop BEFORE starting another model turn once we've crossed the
    // wall-clock budget. Checked here (not mid-turn) so the current turn's
    // assistant/tool_result pair always completes and persists intact —
    // and so turn 0 always runs (elapsed ≈ 0 < budget), guaranteeing a
    // resumed slice makes forward progress instead of pausing on entry.
    // The serverless function would otherwise be hard-killed mid-tool-call
    // at its maxDuration; this converts that silent death into a clean,
    // resumable pause. See `timeBudgetMs`.
    if (deps.timeBudgetMs != null && now() - startedAtMs >= deps.timeBudgetMs) {
      yield { kind: "turn_limit", reason: "time" };
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
    let abortedMidTools = false;
    for (const block of result.toolUseBlocks) {
      if (await deps.shouldAbort?.({ force: true })) {
        abortedMidTools = true;
        break;
      }
      yield { kind: "status", phase: "running_tool", detail: block.name };
      const startedAt = performance.now();
      const tr = await deps.runTool(block);
      yield {
        kind: "status",
        phase: "tool_returned",
        detail: `${block.name} ${tr.ok ? "ok" : "err"} ${Math.round(performance.now() - startedAt)}ms`,
      };
      yield { kind: "tool_use_result", tool_use_id: block.id, ok: tr.ok, preview: tr.preview };
      if (tr.navigateUrl) yield { kind: "navigate", url: tr.navigateUrl };
      toolResults.push(tr.result);
      // Re-check only AFTER the result is recorded. A tool's side effect is
      // durable the instant runTool returns, so aborting in the gap between
      // the write and capturing its tool_result would drop the record of
      // work that already happened — and the next turn, seeing the
      // instruction apparently un-acted-upon, repeats it. (That was the
      // "sent a second message, it re-ran the first instruction" bug.)
      if (await deps.shouldAbort?.({ force: true })) {
        abortedMidTools = true;
        break;
      }
    }

    // Anthropic requires every tool_use block to be answered by a
    // tool_result in the next turn. If we broke out mid-batch with real
    // work to preserve, synthesize results for the tools we never reached
    // so the persisted assistant/tool_result pair stays balanced — an
    // unbalanced pair 400s the next model call.
    if (abortedMidTools && toolResults.length > 0) {
      const answered = new Set(toolResults.map((r) => r.tool_use_id));
      for (const block of result.toolUseBlocks) {
        if (answered.has(block.id)) continue;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: "Superseded by a newer message before this step ran.",
        });
      }
    }

    // One user-role message carrying every tool_result (Anthropic contract).
    // Emitted even on a mid-batch abort — as long as real work committed —
    // so the consumer persists it and the next turn won't repeat it.
    if (toolResults.length > 0) {
      yield { kind: "tool_results", blocks: toolResults };
      deps.messages.push({ role: "user", content: toolResults });
    }

    if (abortedMidTools) {
      yield { kind: "aborted" };
      return;
    }
  }

  // Ran out of turns without the model settling on a final answer.
  yield { kind: "turn_limit", reason: "turns" };
}
