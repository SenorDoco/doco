---
id: decision_01KR441EB1HY7C49GKKYF53WVC
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Drop the `JustifiedBy` edge; use only `Concludes` (Reasoning → Decision/Action). Index makes it traversable in both directions."

slug: drop-justified-by-edge
number: "ADR-014"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "Do we need both `Decision.reasoning_id` and `Reasoning.conclusion_ref`?"
chosen: |
  Single source-of-truth field `Reasoning.conclusion_ref` produces a
  `Concludes` edge. The index makes it traversable in both directions
  (Decision ← Reasoning), so no second field is needed.
alternatives:
  - name: Keep both `Decision.reasoning_id` (→ JustifiedBy) and `Reasoning.conclusion_ref` (→ Concludes)
    rejected_because: "Two fields modeling the same relationship is genuine duplication. The index resolves directionality at query time."
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

# ADR-014 — Drop `JustifiedBy` (use `Concludes` only)

Reference: SCHEMA.md §6, §6.1.
