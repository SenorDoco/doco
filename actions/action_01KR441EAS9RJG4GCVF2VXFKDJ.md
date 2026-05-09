---
id: action_01KR441EAS9RJG4GCVF2VXFKDJ
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 5: @evalo/discovery (5-strategy find-rules + glossary + embeddings interface), web layer (initially Hono+JSX SSR; superseded by ADR-055 Remix migration)."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: implement_phase
target: intent_01KR441EAEM5NQBM160763TDDT

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
  - intent_01KR441EAA9Y78V8DEKYDB4CWP

decision_ids:
  - decision_01KR441EBHFPX0HJM33TNRJC6M   # ADR-030 5-strategy retrieval
  - decision_01KR441EBJAPKRA4JNWPZWMXEX   # ADR-031 vector embeddings
  - decision_01KR441EBK4VVQN19Q8AHYV8D0   # ADR-032 glossary.yaml
  - decision_01KR441EBMZYHYKE0RMVCKY3RN   # ADR-033 hard/soft separation
  - decision_01KR441EA6NANY4BMWK17S83HN   # ADR-052 embedding model pluggable
  - decision_01KR441EC0TNQSZYYS0EXB975C   # ADR-045 recent-changes feed = home

inputs:
  phase: 5
  embedding_provider_default: noop   # NoopEmbeddingProvider; OpenAI lands when EVALO_EMBEDDING_API_KEY is set

outputs:
  packages_created: [discovery, web]
  cli_added: [find-rules]
  test_files: 1
  tests_pass: 3
  initial_web_stack: "Hono + JSX SSR (later superseded by Remix per ADR-055)"
  phase_end_demo: |
    - Chrome E2E across /, /e/decision/<id>, /lint, /search?q=priority
    - find-rules with --verb delete_evalo --actor <agent> → PRECISE: only-humans-delete-evalo
    - find-rules with --description "validate user input" → 5 FTS hits ranked
  commit: 5d83251

started_at: 2026-05-08T17:45:00Z
ended_at: 2026-05-08T17:55:00Z

created_at: 2026-05-08T17:55:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 5 — discovery + web SSR

Initial web shipped as Hono+JSX SSR for time-pressure reasons (ADR-055 calls
this out as a deviation from ADR-046's Remix choice). Migrated to Remix v7
in the next action ([action_migrate-to-remix](action_01KR441EAT66CAM5X3QRFF8QM9.md)).

The discovery package's embedding interface is provider-pluggable per
ADR-052; default is the NoopEmbeddingProvider so semantic tier degrades to
FTS5-only when no API key is configured.
