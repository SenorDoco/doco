// Token-cost arithmetic for Señor Doco usage, shared by the server
// (per-thread snapshot totals) and the client (rendering the Thinking
// panel meter). Pure — no DB or env — so it imports cleanly into both
// bundles and is trivially unit-testable.

/** The four token counters Anthropic reports and bills on. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** Per-model aggregate row, as summed out of `agent_turn_metrics`. */
export interface ThreadUsageModelRow extends TokenUsage {
  model: string;
  turn_count: number;
}

/** Whole-thread totals plus the derived dollar estimate. */
export interface ThreadUsage extends TokenUsage {
  turn_count: number;
  estimated_cost_usd: number;
}

interface ModelRates {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

// USD per million tokens, from Anthropic's published pricing. Keep these
// near the rate selector so a model swap is a one-line edit. Señor Doco's
// default model is Haiku (see SENOR_DOCO_DEFAULT_MODEL in
// assistant-runtime.server.ts), but an unknown/unrecognized model id prices
// as Sonnet — the conservative middle of the three rate cards.
const SONNET_RATES: ModelRates = {
  inputPerM: 3,
  outputPerM: 15,
  cacheReadPerM: 0.3,
  cacheWritePerM: 3.75,
};
const HAIKU_RATES: ModelRates = {
  inputPerM: 0.8,
  outputPerM: 4,
  cacheReadPerM: 0.08,
  cacheWritePerM: 1,
};
const OPUS_RATES: ModelRates = {
  inputPerM: 15,
  outputPerM: 75,
  cacheReadPerM: 1.5,
  cacheWritePerM: 18.75,
};

/** Pick the rate card for a model id. Unknown/empty → Sonnet (the default). */
export function ratesForModel(model: string | null | undefined): ModelRates {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return OPUS_RATES;
  if (m.includes("haiku")) return HAIKU_RATES;
  return SONNET_RATES;
}

/** Estimated USD cost of one usage bucket, priced for the given model. */
export function estimateTokenCostUsd(usage: TokenUsage, model: string | null | undefined): number {
  const r = ratesForModel(model);
  return (
    (usage.input_tokens * r.inputPerM) / 1e6 +
    (usage.output_tokens * r.outputPerM) / 1e6 +
    (usage.cache_read_tokens * r.cacheReadPerM) / 1e6 +
    (usage.cache_creation_tokens * r.cacheWritePerM) / 1e6
  );
}

/**
 * Roll per-model metric rows up into one thread total. Each bucket is
 * priced with its own model's rates, so a thread that spanned models (an
 * env override mid-conversation) costs out correctly rather than pricing
 * everything at a single rate.
 */
export function aggregateThreadUsage(rows: ThreadUsageModelRow[]): ThreadUsage {
  const total: ThreadUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turn_count: 0,
    estimated_cost_usd: 0,
  };
  for (const row of rows) {
    total.input_tokens += row.input_tokens;
    total.output_tokens += row.output_tokens;
    total.cache_read_tokens += row.cache_read_tokens;
    total.cache_creation_tokens += row.cache_creation_tokens;
    total.turn_count += row.turn_count;
    total.estimated_cost_usd += estimateTokenCostUsd(row, row.model);
  }
  return total;
}
