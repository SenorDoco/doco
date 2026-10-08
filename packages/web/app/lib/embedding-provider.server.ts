// Single source of truth for picking the embedding provider during
// reindex (ADR-052). Returns `undefined` when no API key is configured,
// which the reindex code-path interprets as "skip embeddings entirely."
// The Noop provider is intentionally NOT returned here — passing a Noop
// would walk every entity to no effect; absence skips the loop.
//
// We wrap the upstream provider with a thin telemetry layer that
// fire-and-forgets a row into `openai_usage_log` for every embed
// call — that's how the admin dashboard counts what the OpenAI key
// has burned through. The wrapper preserves the provider's contract
// exactly; it just records.
import type { SemanticQuery } from "@doco/db";
import {
  type EmbeddingInputType,
  type EmbeddingProvider,
  NoopEmbeddingProvider,
  getDefaultEmbeddingProvider,
} from "@doco/index";
import { waitUntil } from "@vercel/functions";
import { recordOpenAiUsage } from "./telemetry.server";

let cached: EmbeddingProvider | undefined | null = null;

function wrapWithUsageLog(inner: EmbeddingProvider): EmbeddingProvider {
  return {
    modelId: inner.modelId,
    dimensions: inner.dimensions,
    async embed(
      texts: string[],
      inputType?: EmbeddingInputType,
      signal?: AbortSignal,
    ): Promise<Float32Array[]> {
      const start = performance.now();
      const totalChars = texts.reduce((n, s) => n + s.length, 0);
      try {
        const out = await inner.embed(texts, inputType, signal);
        waitUntil(
          recordOpenAiUsage({
            model: inner.modelId,
            input_count: texts.length,
            total_chars: totalChars,
            request_ms: Math.round(performance.now() - start),
            ok: true,
            error: null,
          }),
        );
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        waitUntil(
          recordOpenAiUsage({
            model: inner.modelId,
            input_count: texts.length,
            total_chars: totalChars,
            request_ms: Math.round(performance.now() - start),
            ok: false,
            error: msg.slice(0, 500),
          }),
        );
        throw err;
      }
    },
  };
}

/** Returns the active provider, or undefined if none is configured. */
export function getDocoEmbeddingProvider(): EmbeddingProvider | undefined {
  if (cached !== null) return cached ?? undefined;
  const provider = getDefaultEmbeddingProvider();
  cached = provider instanceof NoopEmbeddingProvider ? undefined : wrapWithUsageLog(provider);
  return cached;
}

/**
 * The query side of a semantic search: the query embedded by the active
 * provider, with the model that produced it. `semantic` is null, with the
 * reason in `warning`, when there is no provider or the call failed (or
 * `signal` aborted it); search then degrades to full-text rather than
 * returning nothing.
 */
export async function embedQuery(
  text: string,
  signal?: AbortSignal,
): Promise<{ semantic: SemanticQuery | null; warning: string | null }> {
  const provider = getDocoEmbeddingProvider();
  if (!provider) {
    return {
      semantic: null,
      warning:
        "Semantic ranking unavailable (no embedding provider configured); showing keyword matches.",
    };
  }
  try {
    const [vector] = await provider.embed([text], "query", signal);
    if (!vector || vector.length === 0) {
      return {
        semantic: null,
        warning:
          "Semantic ranking unavailable (provider returned an empty embedding); showing keyword matches.",
      };
    }
    return { semantic: { queryEmbedding: vector, modelId: provider.modelId }, warning: null };
  } catch (e) {
    return {
      semantic: null,
      warning: `Semantic ranking unavailable (${(e as Error).message}); showing keyword matches.`,
    };
  }
}
