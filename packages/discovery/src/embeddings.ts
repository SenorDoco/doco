/**
 * EmbeddingProvider interface per ADR-052. Default: no-op (FTS only). When
 * EVALO_EMBEDDING_PROVIDER=openai is set with EVALO_EMBEDDING_API_KEY, an
 * OpenAI provider is wired in. Self-hosted users can swap to a local
 * sentence-transformers process.
 *
 * For phase 5, the OpenAI provider is implemented as a stub — fetch wiring
 * lands when the key is supplied. Until then, semantic discovery degrades
 * to FTS5 (still useful, just less recall).
 */

export interface EmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  modelId = "noop";
  dimensions = 0;
  async embed(_texts: string[]): Promise<Float32Array[]> {
    return _texts.map(() => new Float32Array(0));
  }
}

/**
 * OpenAI text-embedding-3-small. Lazy-instantiated; doesn't actually call
 * the API until embed() is invoked, so missing-key environments don't fail
 * at import time.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  modelId = "openai:text-embedding-3-small";
  dimensions = 1536;

  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI embedding request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => new Float32Array(d.embedding));
  }
}

export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EVALO_EMBEDDING_PROVIDER ?? "noop";
  const apiKey = process.env.EVALO_EMBEDDING_API_KEY ?? "";
  if (provider === "openai" && apiKey) {
    return new OpenAIEmbeddingProvider(apiKey);
  }
  return new NoopEmbeddingProvider();
}
