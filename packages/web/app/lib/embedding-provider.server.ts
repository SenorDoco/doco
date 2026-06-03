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
    async embed(texts: string[], inputType?: EmbeddingInputType): Promise<Float32Array[]> {
      const start = performance.now();
      const totalChars = texts.reduce((n, s) => n + s.length, 0);
      try {
        const out = await inner.embed(texts, inputType);
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
