---
id: action_01KR441EAP27DP8RX8JVY6S3QK
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 2: @evalo/index (SQLite + FTS5 + edges + scope_match); reindex 79 entities in 6 ms; one-hop edge query in 0.36 ms."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: implement_phase
target: intent_01KR441EAEM5NQBM160763TDDT

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
  - intent_01KR441EAA9Y78V8DEKYDB4CWP   # runtime-checking (depends on index)

decision_ids:
  - decision_01KR441EBAXTCN4P60ZDC61ZV9   # ADR-023 tiered architecture
  - decision_01KR441EBB0R991A2P0XXV0VR1   # ADR-024 SQLite + FTS5
  - decision_01KR441EBC9QWZVT240Q78R021   # ADR-025 edges adjacency
  - decision_01KR441EAC4VGX4QM3NFDEK1MW   # ADR-059 better-sqlite3 binding
  - decision_01KR441EB4D3NMVGJYJX5PHQZF   # ADR-017 fields-as-edges

inputs:
  phase: 2

outputs:
  packages_created: [index]
  cli_added: [reindex, query]
  test_files: 1
  tests_pass: 5
  phase_end_demo: "decisions-serving-implementation-v0 query in 0.36 ms; FTS5 'priority' query in 0.66 ms — well under sub-10 ms (ADR-049)"
  commit: cab0b16

started_at: 2026-05-08T17:15:00Z
ended_at: 2026-05-08T17:25:00Z

created_at: 2026-05-08T17:25:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 2 — SQLite + FTS5 query layer

Per-type tables mirror the schema's most-queried fields; `raw_json` carries
the full entity for nested-field access. Edges are derived per ADR-017 from
ID-shaped fields; the FIELD_TO_EDGE_TYPE map maps `intent_ids → serves`,
`decision_ids → enacts`, etc. FTS5 over summary + body powers Phase 5's
search and the discovery package's semantic tier.

scope_match table is created but unpopulated until Phase 3's check engine
wires it.
