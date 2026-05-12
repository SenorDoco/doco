---
id: decision_01KR441EAWNQ4ZAPG0XGA9RJZX
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Ten node types: principal, doco, intent, rule, decision, action, reasoning, evaluation, reference, tag."

slug: final-node-type-list
number: "ADR-009"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "What set of entity kinds does Doco support?"
chosen: |
  10 kinds: `principal`, `doco`, `intent`, `rule`, `decision`, `action`,
  `reasoning`, `evaluation`, `reference`, `tag`. Each earns its place by
  having a distinct shape and lifecycle. Aggressive consolidation kept the
  surface narrow.
alternatives:
  - name: Separate Constraint + Assertion
    rejected_because: "Same conceptual thing — 'a statement of correctness' — distinguished only by *when* it's evaluated. Collapsed → Rule (D-010)."
  - name: First-class Membership entity
    rejected_because: "No genuine independent lifecycle worth a node. Collapsed → MemberOf edge (D-011)."
  - name: Plan, Question, Claim, Scope as first-class entities
    rejected_because: "Plan is emergent from Intent + Decision + Action chains. Question is folded into Decision.question. Claim is Reasoning.conclusion. Scope is reserved-tag-prefix (D-028). Promote any of these only if real use cases demand."
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

# ADR-009 — Final node type list (10 total)

Reference: SCHEMA.md §4.
