---
id: action_01KR6XDDMH0G9XJ41AHYG0SRHF
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 15 — added `follows` field on common_fields for BPMN-style ordering. Schema, TS type, edges enum, SCHEMA.md diagram + table, cycle-detection lint with 5 unit-test cases. Self-applies via this Action's own `follows` chain."

actor_id: claude-opus-4-7
verb: add_follows_field

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6XDDMF2XH22F71VJ2HDEA1   # ADR-077

follows:
  - decision_01KR6XDDMF2XH22F71VJ2HDEA1   # the Decision this Action operationalizes
  - action_01KR6WS48Y2NRKVQ2429BTRKFP     # Phase 14 (graph map) — ordered before this work
  - action_01KR6V6W4K5T9CVGXVYB7HPCXM     # Phase 13 (graph quality) — ordered before this work

inputs:
  user_direction: |
    "to better handle BPMN-style documentation, let's:
    * Common fields: add follows: [<entity_id>] (optional, defaults
      to empty). One line.
    * Relationships: add * --follows--> * to the diagram with a note
      'ordering / dependency; lint forbids cycles.'
    * Fields-as-edges table: add *.follows[] → Follows.
    * SQLite edges enum: add follows to the edge_type comment."
  also_in_this_turn: |
    "Here is the API key store it in the .env file: <key>"
    "For vector embeddings, let's use the same key that is used by
    /Speco" → already wired in action_01KR6W4640XHFBQQV0C1A4TYFR.

outputs:
  source_files_changed:
    - schema/doco.schema.json                                   # follows added to common_fields with description + items ref to id
    - packages/shared/src/entities.ts                            # follows?: EntityId[] on CommonFields
    - packages/index/src/edges.ts                                # FIELD_TO_EDGE_TYPE.follows = 'follows'
    - packages/index/src/migrate.ts                              # extended edges.edge_type comment to enumerate edge types including follows
    - SCHEMA.md                                                  # §6 diagram + §6.1 fields-as-edges table + edge_type comment
    - packages/lints/src/follows-cycle.ts                        # NEW — DFS-based cycle detection, severity: error
    - packages/lints/src/index.ts                                # registered follows-cycle in SYSTEM_LINTS
    - packages/lints/src/__tests__/lints.test.ts                 # added 5 synthetic-graph cycle tests + meta-Doco no-cycle test
    - .env                                                       # NEW — OPENAI_API_KEY (per the user's direction; gitignored)
    - decisions/decision_01KR6XDDMF2XH22F71VJ2HDEA1.md           # ADR-077
    - packages/index/src/__tests__/build.test.ts                 # bumped counts
    - packages/core/src/__tests__/loader.test.ts                 # bumped lower-bound

  tests_run:
    - "pnpm --filter @doco/lints test → 9/9 passed (4 existing + 5 new follows-cycle cases)"
    - "pnpm doco validate → All entities valid (now includes follows fields on this Action and ADR-077)"
    - "pnpm doco lint → 4 lints clean, connectivity has 8 pre-existing warnings (bootstrap Rules)"
    - "Chrome verification — homepage works, entity-detail with map works, type filters work, click-to-navigate works"

  follows_self_application:
    - "ADR-077 follows: [ADR-075, ADR-076]"
    - "This Action follows: [ADR-077, action_Phase-14, action_Phase-13] — chronological + dependency"
    - "follows-cycle lint reports clean against the meta-Doco — the chain is a DAG"

started_at: 2026-05-09T18:20:00Z
ended_at: 2026-05-09T18:35:00Z

created_at: 2026-05-09T18:35:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 15 — `follows` field for BPMN ordering

## What ships

A new common_fields entry: `follows?: EntityId[]`. Any entity can
declare the entities it comes after. The indexer derives a `follows`
edge per id; the new lint forbids cycles.

The user gave four sub-tasks. Each landed:

| Task | Where |
|---|---|
| Common field `follows: [<entity_id>]` | `schema/doco.schema.json` + TS `CommonFields` |
| `* --follows--> *` in the diagram with cycle-forbidding note | `SCHEMA.md` §6 |
| `*.follows[] → Follows` in fields-as-edges table | `SCHEMA.md` §6.1 |
| `follows` in SQLite edges enum comment | `packages/index/src/migrate.ts` |

Plus the cycle lint (the user mentioned it in the diagram note;
shipping the lint itself was the natural next step). 5 synthetic-
graph unit tests exercise: acyclic chain (clean), self-loop (cycle),
2-node cycle (cycle), 3-node cycle (cycle), mixed disjoint (one
cycle reported).

## Self-application

ADR-077 has `follows: [ADR-075, ADR-076]` — it sits in the
chronological / dependency chain after the connectivity Decision
(ADR-075) and the graph map Decision (ADR-076).

This Action has `follows: [ADR-077, action_Phase-14,
action_Phase-13]` — operationalizing ADR-077, after the prior phase
Actions in order.

The cycle lint reports clean: the chain is a DAG.

## OPENAI_API_KEY

The user provided an API key in this turn for the embedding provider
to consume (already wired by `action_01KR6W4640XHFBQQV0C1A4TYFR`).
Stored in `.env` (gitignored). The user explicitly noted this is a
dev environment and the key will expire. No further action required
from this Action.
