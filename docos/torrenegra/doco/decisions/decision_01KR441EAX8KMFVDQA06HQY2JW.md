---
id: decision_01KR441EAX8KMFVDQA06HQY2JW
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Constraint and Assertion collapsed into a single `Rule` entity differentiated by `phase: declared | pre | post | invariant`."

slug: rule-subsumes-constraint-and-assertion
number: "ADR-010"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "Are Constraint and Assertion separate entity kinds?"
chosen: |
  Single `Rule` entity. `phase: declared` = old Constraint (policy that
  always holds); `phase: pre | post | invariant` = old Assertion (runtime
  evaluation point). Same predicate language, same scope-matching, same
  Evaluation production — they were genuinely the same thing distinguished
  only by *when* evaluated.
alternatives:
  - name: Keep Constraint and Assertion separate
    rejected_because: "Genuine duplication. Same fields, same machinery; only the evaluation moment differs — which is exactly what `phase` captures."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-010 — Constraint + Assertion → unified `Rule` with `phase`

Reference: SCHEMA.md §4.4.
