---
id: action_01KR6W4640XHFBQQV0C1A4TYFR
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Wired Doco's embedding provider to read OPENAI_API_KEY (matching Speco's convention). Dropped DOCO_EMBEDDING_PROVIDER and DOCO_EMBEDDING_API_KEY — pre-v1, no back-compat."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: switch_embedding_key_to_openai_api_key

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EA6NANY4BMWK17S83HN   # ADR-052 — embedding provider design (env-var name updated; design unchanged)
  - decision_01KR6V6W4HMM5CBJV22FD0HFSP   # ADR-075 — graph-quality strategy (mentioned the env var)

inputs:
  user_direction: |
    "For vector embeddings, let's use the same key that is used by /Speco"
  speco_convention: "OPENAI_API_KEY"

outputs:
  source_files_changed:
    - packages/discovery/src/embeddings.ts                              # getDefaultEmbeddingProvider reads OPENAI_API_KEY directly; provider switch is implicit (key present → openai; key absent → noop)
    - decisions/decision_01KR6V6W4HMM5CBJV22FD0HFSP.md                  # ADR-075 prose updated DOCO_EMBEDDING_API_KEY → OPENAI_API_KEY
  what_was_dropped:
    - "DOCO_EMBEDDING_PROVIDER (was: 'openai' | 'noop' switch)"
    - "DOCO_EMBEDDING_API_KEY (was: provider-specific key)"
  rationale: |
    Speco already uses OPENAI_API_KEY. A user running both projects on
    the same machine doesn't want two env vars holding the same secret.
    Doco's noop-vs-openai switch was implicit anyway (the key's presence
    determined which provider to instantiate); collapsing the explicit
    DOCO_EMBEDDING_PROVIDER doesn't lose functionality. If a different
    provider lands later (Voyage, Cohere, local sentence-transformers),
    add a new Provider class and a small switch — but until then, one
    env var is enough.

started_at: 2026-05-09T17:45:00Z
ended_at: 2026-05-09T17:48:00Z

created_at: 2026-05-09T17:48:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Switched embedding key to OPENAI_API_KEY

The user runs Doco alongside Speco on the same machine. Speco already
uses `OPENAI_API_KEY`. Doco was reading from `DOCO_EMBEDDING_API_KEY`
plus a `DOCO_EMBEDDING_PROVIDER=openai|noop` switch. Two env vars
holding the same secret is friction.

`packages/discovery/src/embeddings.ts` now reads `OPENAI_API_KEY`
directly. If it's set, the OpenAI provider runs (text-embedding-3-small,
1536 dims). If it's not, the noop provider runs (FTS-only — still
useful). The explicit provider switch is gone; the key's presence
determines the provider implicitly.

Per the no-back-compat-pre-v1 principle, no fallback to the old env
var names. Anyone running an existing dev shell with `DOCO_EMBEDDING_*`
set will see no embedding provider activate; they update their `.env`.

The historical Decision (ADR-052) stays as written — its design
(swappable provider with a no-op default) is unchanged. Only the env
var name flipped, recorded here.
