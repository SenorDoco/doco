---
id: decision_01KR441EA6NANY4BMWK17S83HN
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Embedding model: OpenAI `text-embedding-3-small` (1536d) is the default for SaaS; pluggable interface lets self-hosted Docos use sentence-transformers (e.g., `all-MiniLM-L6-v2`, 384d)."

slug: embedding-model-default-and-pluggable
number: "ADR-052"
intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "What embedding model powers semantic Rule discovery (D-031)?"
chosen: |
  Default: OpenAI `text-embedding-3-small` (1536-dim). Fast, cheap, broadly
  available. Self-hosted Docos can swap to a local model (sentence-transformers
  `all-MiniLM-L6-v2`, 384-dim) by setting an env var; the embedding interface
  is provider-agnostic and `cache.embedding_version` tracks which model
  produced the current vectors.
alternatives:
  - name: Single hardcoded model (e.g., always OpenAI)
    rejected_because: "Forces self-hosted users to pay per-token to a third party. Bad for adoption."
  - name: No semantic search at all (v0)
    rejected_because: "D-030 / D-031 already settled that semantic discovery is part of the 5-strategy retrieval. Removing it weakens advisory tier."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-052 — Embedding model = OpenAI default, pluggable

## Provider interface (sketch)

```ts
export interface EmbeddingProvider {
  modelId: string;            // e.g. "openai:text-embedding-3-small"
  dimensions: number;         // e.g. 1536 — drives sqlite-vec column width
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

Selection by env: `DOCO_EMBEDDING_PROVIDER=openai|local|none` and
`DOCO_EMBEDDING_API_KEY=<key>` for paid providers. Default `none` falls back
to FTS5-only — semantic discovery degrades gracefully.

## Cache invalidation

Bumping `cache.embedding_version` (e.g., on model swap) triggers re-embedding
of all Rules. Embeddings are content-hashed against `<summary>\n<body>` so
edits trigger per-row re-embed only.
