// Single source of truth for picking the embedding provider during
// reindex (ADR-052). Returns `undefined` when no API key is configured,
// which the reindex code-path interprets as "skip embeddings entirely."
// The Noop provider is intentionally NOT returned here — passing a Noop
// would walk every entity to no effect; absence skips the loop.
import {
  getDefaultEmbeddingProvider,
  NoopEmbeddingProvider,
  type EmbeddingProvider,
} from "@doco/index";

let cached: EmbeddingProvider | undefined | null = null;

/** Returns the active provider, or undefined if none is configured. */
export function getDocoEmbeddingProvider(): EmbeddingProvider | undefined {
  if (cached !== null) return cached ?? undefined;
  const provider = getDefaultEmbeddingProvider();
  cached = provider instanceof NoopEmbeddingProvider ? undefined : provider;
  return cached;
}

/** Test-only: clear the memoized provider. */
export function _resetEmbeddingProviderForTests(): void {
  cached = null;
}
