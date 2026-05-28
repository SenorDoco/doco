// Per-turn / per-capture timing telemetry. Two surfaces:
//
//   1. `withCaptureTelemetry(fn)` — AsyncLocalStorage-scoped bag that
//      collects phase timings from anywhere in the capture call stack
//      (persist, authoring evaluator, LLM judge, reindex). The wrapping
//      route reads the filled bag once the captureFn resolves.
//
//   2. `recordAgentTurn(row)` / `recordCaptureTiming(row)` — fire-and-
//      forget Postgres inserts. Called via `waitUntil` so telemetry
//      never adds latency to the request that produced it. Failures
//      log and are swallowed; missing telemetry is preferable to a
//      broken response.
//
// Why AsyncLocalStorage: capture functions are deeply nested across
// route → factory → captureDecision → persistEntity → reindex →
// loadDocoFromPostgres. Threading a `phaseBag` parameter through nine
// capture functions plus the reindex stack would touch every signature
// in the system. Async-local state keeps the wiring at the boundary.

import { AsyncLocalStorage } from "node:async_hooks";
import { withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";

export interface CapturePhaseBag {
  persist_ms: number;
  authoring_ms: number;
  judge_ms: number;
  judge_calls: number;
  reindex_structural_ms: number;
  reindex_load_ms: number;
  reindex_load_entity_count: number;
}

function emptyBag(): CapturePhaseBag {
  return {
    persist_ms: 0,
    authoring_ms: 0,
    judge_ms: 0,
    judge_calls: 0,
    reindex_structural_ms: 0,
    reindex_load_ms: 0,
    reindex_load_entity_count: 0,
  };
}

const PHASE_STORAGE = new AsyncLocalStorage<CapturePhaseBag>();

/**
 * Run `fn` inside a fresh capture-phase context. Any code in the
 * resulting async stack that calls `recordPhase` / `recordPhaseCount`
 * writes into `bag`. The caller gets `{ result, bag }` back so the
 * route can record the per-phase timings alongside the response.
 */
export async function withCaptureTelemetry<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; bag: CapturePhaseBag }> {
  const bag = emptyBag();
  const result = await PHASE_STORAGE.run(bag, fn);
  return { result, bag };
}

type NumericPhase = "persist_ms" | "authoring_ms" | "judge_ms" | "reindex_structural_ms";
type CounterPhase = "judge_calls";

/**
 * Add `ms` to the named phase in the active capture context. No-op
 * when called outside `withCaptureTelemetry` (e.g. CLI captures,
 * tests). Adds rather than sets so repeat-invocations within one
 * capture (multiple judge calls, retried persists) accumulate.
 */
export function recordPhase(name: NumericPhase, ms: number): void {
  const bag = PHASE_STORAGE.getStore();
  if (!bag) return;
  bag[name] += ms;
}

export function recordPhaseCount(name: CounterPhase, n: number): void {
  const bag = PHASE_STORAGE.getStore();
  if (!bag) return;
  bag[name] += n;
}

/**
 * Record the reindex's full-Doco load cost in one shot. Called from
 * the redeem wrapper once `reindexBare` returns its `BuildReport`.
 * The reindex pipeline lives in `@doco/index` and can't import this
 * file (web-only); we surface the numbers via the BuildReport and
 * stash them here.
 */
export function recordReindexLoad(loadMs: number, entityCount: number): void {
  const bag = PHASE_STORAGE.getStore();
  if (!bag) return;
  bag.reindex_load_ms += loadMs;
  bag.reindex_load_entity_count += entityCount;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface CaptureTimingRow {
  doco_id: string;
  entity_type: string;
  http_method: "POST" | "PATCH";
  principal_id: string | null;
  total_ms: number;
  bag: CapturePhaseBag;
  status_code: number | null;
  user_agent: string | null;
  error: string | null;
}

export async function recordCaptureTiming(row: CaptureTimingRow): Promise<void> {
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO capture_timings (
            id, doco_id, entity_type, http_method, principal_id, total_ms,
            persist_ms, authoring_ms, judge_ms, judge_calls,
            reindex_structural_ms, reindex_load_ms, reindex_load_entity_count,
            status_code, user_agent, error
         ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13,
            $14, $15, $16
         )`,
        [
          `ct_${generateUlid()}`,
          row.doco_id,
          row.entity_type,
          row.http_method,
          row.principal_id,
          row.total_ms,
          row.bag.persist_ms,
          row.bag.authoring_ms,
          row.bag.judge_ms,
          row.bag.judge_calls,
          row.bag.reindex_structural_ms,
          row.bag.reindex_load_ms,
          row.bag.reindex_load_entity_count,
          row.status_code,
          row.user_agent,
          row.error,
        ],
      );
    });
  } catch (err) {
    console.error("[telemetry] capture_timings insert failed:", (err as Error).message);
  }
}

export interface AgentTurnRow {
  conversation_id: string;
  user_id: string;
  model: string;
  total_ms: number;
  bootstrap_ms: number;
  history_load_ms: number;
  first_text_token_ms: number | null;
  num_anthropic_calls: number;
  num_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  history_message_count: number;
  attachment_count: number;
  stop_reason: string | null;
  error: string | null;
  /**
   * Per-call detail: { anthropic_calls: [...], tool_calls: [...] }.
   * Free-form so adding new measurements doesn't require a migration.
   */
  phases: Record<string, unknown>;
}

/**
 * Eager / incremental write of an agent_turn_metrics row. INSERTs on
 * first call, UPDATEs on subsequent ones. Callers generate the `id`
 * up front so the same row can be progressively filled in as the
 * turn progresses — critical for diagnosing lambdas that get SIGKILL'd
 * before the `finally` block fires (a fire-and-forget flush in finally
 * loses everything when Vercel kills the function on timeout).
 *
 * Idempotent on (id). The `started_at` column keeps its original
 * INSERT-time value across UPDATEs.
 */
export async function upsertAgentTurn(id: string, row: AgentTurnRow): Promise<void> {
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO agent_turn_metrics (
            id, conversation_id, user_id, model, total_ms,
            bootstrap_ms, history_load_ms, first_text_token_ms,
            num_anthropic_calls, num_tool_calls,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            history_message_count, attachment_count, stop_reason, error, phases
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19::jsonb
         )
         ON CONFLICT (id) DO UPDATE SET
            total_ms = EXCLUDED.total_ms,
            bootstrap_ms = EXCLUDED.bootstrap_ms,
            history_load_ms = EXCLUDED.history_load_ms,
            first_text_token_ms = EXCLUDED.first_text_token_ms,
            num_anthropic_calls = EXCLUDED.num_anthropic_calls,
            num_tool_calls = EXCLUDED.num_tool_calls,
            input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens,
            cache_read_tokens = EXCLUDED.cache_read_tokens,
            cache_creation_tokens = EXCLUDED.cache_creation_tokens,
            history_message_count = EXCLUDED.history_message_count,
            attachment_count = EXCLUDED.attachment_count,
            stop_reason = EXCLUDED.stop_reason,
            error = EXCLUDED.error,
            phases = EXCLUDED.phases`,
        [
          id,
          row.conversation_id,
          row.user_id,
          row.model,
          row.total_ms,
          row.bootstrap_ms,
          row.history_load_ms,
          row.first_text_token_ms,
          row.num_anthropic_calls,
          row.num_tool_calls,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens,
          row.cache_creation_tokens,
          row.history_message_count,
          row.attachment_count,
          row.stop_reason,
          row.error,
          JSON.stringify(row.phases),
        ],
      );
    });
  } catch (err) {
    console.error("[telemetry] agent_turn_metrics upsert failed:", (err as Error).message);
  }
}

export async function recordAgentTurn(row: AgentTurnRow): Promise<void> {
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO agent_turn_metrics (
            id, conversation_id, user_id, model, total_ms,
            bootstrap_ms, history_load_ms, first_text_token_ms,
            num_anthropic_calls, num_tool_calls,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            history_message_count, attachment_count, stop_reason, error, phases
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19::jsonb
         )`,
        [
          `atm_${generateUlid()}`,
          row.conversation_id,
          row.user_id,
          row.model,
          row.total_ms,
          row.bootstrap_ms,
          row.history_load_ms,
          row.first_text_token_ms,
          row.num_anthropic_calls,
          row.num_tool_calls,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens,
          row.cache_creation_tokens,
          row.history_message_count,
          row.attachment_count,
          row.stop_reason,
          row.error,
          JSON.stringify(row.phases),
        ],
      );
    });
  } catch (err) {
    console.error("[telemetry] agent_turn_metrics insert failed:", (err as Error).message);
  }
}

export interface OpenAiUsageRow {
  model: string;
  input_count: number;
  total_chars: number;
  request_ms: number | null;
  ok: boolean;
  error: string | null;
}

/**
 * Persist one OpenAI embedding-call usage record. Fire-and-forget
 * via the caller's `waitUntil` so the embedding call itself isn't
 * delayed by the telemetry write.
 */
export async function recordOpenAiUsage(row: OpenAiUsageRow): Promise<void> {
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO openai_usage_log
           (id, model, input_count, total_chars, request_ms, ok, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          `oai_${generateUlid()}`,
          row.model,
          row.input_count,
          row.total_chars,
          row.request_ms,
          row.ok,
          row.error,
        ],
      );
    });
  } catch (err) {
    console.error("[telemetry] openai_usage_log insert failed:", (err as Error).message);
  }
}
