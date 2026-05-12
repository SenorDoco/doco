---
id: action_01KR441EAQ4NFGD2HX8QE9RP84
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 3: @doco/runtime (predicate + scope + check engine), @doco/lints (4 system lints), `doco check` and `doco lint`. The alignment loop closes."

actor_id: claude-opus-4-7
verb: implement_phase
target: intent_01KR441EAA9Y78V8DEKYDB4CWP   # runtime-checking

intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EA2VSXQ1GHX8AKSV2VJ   # ADR-048 JSON DSL predicates
  - decision_01KR441EAX8KMFVDQA06HQY2JW   # ADR-010 Rule = Constraint + Assertion
  - decision_01KR441EBDM29DN9WQ08TET4D8   # ADR-026 scope_match denormalization
  - decision_01KR441EA8QFSX5Q6CHNVCKMJ0   # ADR-054 Q#12 → PII Rule

inputs:
  phase: 3
  rule_migrated_to_json_dsl: rule_01KR441EAH8KJZ2F4TMP8YPQPB   # only-humans-delete-doco

outputs:
  packages_created: [runtime, lints]
  cli_added: [check, lint]
  test_files: 2
  tests_pass: 10
  rules_added_in_backfill_pass: 3   # see action_01KR441EAVAACD014TK7XH49WK
  phase_end_demo: |
    - draft Action (agent delete_doco) → BLOCKED with `"agent" == "human" is false`
    - draft Action (human delete_doco) → passes
    - `doco lint` reports 0 errors / 0 warnings against this Doco
  commit: 8e94122

started_at: 2026-05-08T17:25:00Z
ended_at: 2026-05-08T17:35:00Z

created_at: 2026-05-08T17:35:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 3 — runtime check + lints; alignment loop closes

The JSON DSL predicate evaluator handles eq/ne/lt/lte/gt/gte/in/not/and/or/
matches_regex/path_exists/is_null. Scope matcher resolves
{all|id|node_type|tag|intent_id|actor_type|any_of|all_of} against any
candidate, falling back to the index db for tag and edge resolution. Check
engine pulls active pre/invariant Rules, evaluates each, builds a
CheckReport with .blocked = any must/must_not failure.

Critical loop demonstrated: Intent (dual-user-model) → Decision (ADR-040
only humans delete) → Rule (rule_only_humans_delete_doco with JSON DSL
`{"op":"eq","left":{"path":"actor.type"},"right":"human"}`) → runtime check
gates the draft Action.

The 4 lints (orphan-Reasoning, agent-ancestry, bugfix-guard,
pii-display-name) ship as TypeScript functions in @doco/lints. Three of
them lacked corresponding Rule entities at Phase 3 close — backfilled later
(see [action_backfill](action_01KR441EAVAACD014TK7XH49WK.md)).
