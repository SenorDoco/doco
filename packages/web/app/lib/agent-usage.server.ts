// Anthropic token-usage roll-up behind /admin/agent-usage. Sums the
// `agent_turn_metrics` rows in a time window and prices them. Cost is computed
// PER MODEL via the shared rate cards in `agent-cost.ts`: Señor Doco runs on
// Sonnet and the authoring-policy judge on Haiku, so a window that mixes them
// must price each at its own rate rather than blending everything at one
// model's (which understated spend once Señor Doco moved off Haiku).

import { withClient } from "@doco/db";
import { type ThreadUsageModelRow, aggregateThreadUsage } from "./agent-cost";

/** One time-window's Anthropic usage: token totals summed across every model
 *  that ran, plus the per-model-priced dollar estimate. */
export interface AnthropicUsageBucket {
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_ms: number;
  cost_usd: number;
}

export async function aggregateAnthropicUsage(sinceClause: string): Promise<AnthropicUsageBucket> {
  return await withClient(async (c) => {
    const r = await c.query<{
      model: string | null;
      turn_count: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_creation_tokens: string | null;
      total_ms: string | null;
    }>(
      // Group by model so each bucket can be priced with its own rate card.
      `SELECT model,
              COUNT(*)::text AS turn_count,
              COALESCE(SUM(input_tokens),0)::text AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text AS cache_read_tokens,
              COALESCE(SUM(cache_creation_tokens),0)::text AS cache_creation_tokens,
              COALESCE(SUM(total_ms),0)::text AS total_ms
         FROM agent_turn_metrics
        WHERE ${sinceClause}
        GROUP BY model`,
    );
    const modelRows: ThreadUsageModelRow[] = r.rows.map((row) => ({
      model: row.model ?? "",
      turn_count: Number(row.turn_count ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_tokens: Number(row.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
    }));
    // aggregateThreadUsage rolls the per-model rows into one total and prices
    // each at its own rate. total_ms isn't a token counter, so sum it here.
    const rolled = aggregateThreadUsage(modelRows);
    const total_ms = r.rows.reduce((sum, row) => sum + Number(row.total_ms ?? 0), 0);
    return {
      turn_count: rolled.turn_count,
      input_tokens: rolled.input_tokens,
      output_tokens: rolled.output_tokens,
      cache_read_tokens: rolled.cache_read_tokens,
      cache_creation_tokens: rolled.cache_creation_tokens,
      total_ms,
      cost_usd: rolled.estimated_cost_usd,
    };
  });
}
