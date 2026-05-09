---
id: decision_01KR441EBJAPKRA4JNWPZWMXEX
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Vector embeddings live in the same SQLite cache as FTS5: `rule_embeddings` virtual table (sqlite-vec). One cache; same rebuild story."

slug: vector-embeddings-alongside-fts5
number: "ADR-031"
intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "Where does the vector embedding index live?"
chosen: |
  `rule_embeddings` virtual table (sqlite-vec / sqlite-vss) lives in the same
  `.evalo/cache.db` as the SQL tables. `cache.embedding_version` tracks the
  embedding model; bumping triggers re-embedding (incremental — only changed
  Rules re-embed).
alternatives:
  - name: Separate vector store (e.g., FAISS, ChromaDB)
    rejected_because: "Two caches to manage; two rebuild stories. Embedded vectors with the rest of the index keeps ops simple."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-031 — Vector embedding index alongside FTS5

Reference: SCHEMA.md §10.2.
