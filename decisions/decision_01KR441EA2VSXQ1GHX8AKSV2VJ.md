---
id: decision_01KR441EA2VSXQ1GHX8AKSV2VJ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Predicate language for v0 is a tiny JSON DSL; CEL is the documented future migration target once 5+ real Rules exist."

slug: predicate-language-json-dsl-v0
number: "ADR-048"
intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP   # runtime-checking
question: "What language do Rule predicates use in v0?"
chosen: |
  A tiny JSON DSL. Examples:
    - `{"op": "eq", "left": {"path": "actor.type"}, "right": "human"}`
    - `{"op": "and", "args": [{"op": "eq", ...}, {"op": "ne", ...}]}`
    - `{"op": "matches_regex", "left": {"path": "display_name"}, "right": "^.+@.+\..+$"}`

  Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not`, `and`, `or`,
  `matches_regex`, `path_exists`, `is_null`. Path resolution walks dotted paths
  on the entity-being-evaluated and the action's actor / target context.
alternatives:
  - name: CEL (Common Expression Language)
    rejected_because: "Mature and well-documented, but adds a dep with C++ binding concerns. Defer until 5+ real Rules show the JSON DSL too constraining."
  - name: Sandboxed JavaScript (vm2 / QuickJS)
    rejected_because: "Maximum flexibility at the cost of every security review needing to confront sandbox-escape concerns."
  - name: Lisp-like S-expressions
    rejected_because: "Requires teaching a parser; agents are less fluent than in JSON."
rules_consulted:
  - rule_01KR441EAF7M5QPF65BXGD1ET1
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

# ADR-048 — Predicate language v0 = JSON DSL

Resolves [open question #1](../DECISIONS.md). Implemented in `packages/runtime`
(phase 3). Existing Rule predicates currently written in prose
([rule_priority_order](../rules/rule_01KR441EAF7M5QPF65BXGD1ET1.md),
[rule_only_humans_delete_doco](../rules/rule_01KR441EAH8KJZ2F4TMP8YPQPB.md),
etc.) will be migrated to the JSON DSL during phase 3.

## Migration path to CEL

When `runtime/predicate` is rewritten on top of CEL, a translation layer keeps
existing JSON-DSL predicates working. The Rules' source-of-truth files don't
need to change — the `predicate:` field is a string and the engine selects the
parser based on a `predicate_language: dsl_v0 | cel` field (added when CEL
lands).
