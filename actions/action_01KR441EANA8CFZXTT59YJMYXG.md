---
id: action_01KR441EANA8CFZXTT59YJMYXG
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 1: @doco/shared, @doco/core, @doco/cli; `doco validate` against this Doco passes for 78 entities."

actor_id: claude-opus-4-7
verb: implement_phase
target: intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EA09QKWEH0J9ZY1XFBB   # ADR-046 tech stack
  - decision_01KR441EAS39KJC9RN9WCD648W   # ADR-006 common fields
  - decision_01KR441EAQ1J516HMAMZ66NKRJ   # ADR-004 ULID ids
  - decision_01KR441EAPAGA5XME562JACT5Q   # ADR-003 yaml frontmatter
  - decision_01KR441EAE1W2V5R3GRNB57BN0   # ADR-060 yaml 2.x engine

inputs:
  phase: 1
  scope: "local-first foundation"

outputs:
  packages_created: [shared, core, cli]
  test_files: 5
  tests_pass: 36
  phase_end_demo: "doco validate → 78 entities, 0 errors"
  commit: 02264ff

started_at: 2026-05-08T16:30:00Z
ended_at: 2026-05-08T16:55:00Z

created_at: 2026-05-08T16:55:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Phase 1 — local-first foundation (CLI you can use solo)

@doco/shared exports ULID generation, branded EntityId/Ulid types, time
helpers, and the full discriminated-union of Entity types matching the
schema. @doco/core wires AJV against `schema/doco.schema.json` (with
yaml 2.x as gray-matter's engine per ADR-060), walks the entity directories,
detects orphan refs, and produces a ValidationReport. @doco/cli ships
`doco init`, `show`, `validate` via citty.

Phase-end demo: `doco validate` against this very repo reports 78 entities,
zero schema errors, zero orphan refs.
