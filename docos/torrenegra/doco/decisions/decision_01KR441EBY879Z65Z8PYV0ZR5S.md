---
id: decision_01KR441EBY879Z65Z8PYV0ZR5S
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Every backfilled entity carries a Reference to its original source (Slack permalink, Figma node, PR URL) for traceability and idempotence."

slug: backfilled-entities-carry-reference
number: "ADR-043"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How do we make backfilled entities auditable and idempotent?"
chosen: |
  Every backfilled entity carries a `Reference` (created during import)
  pointing back to the source — Slack permalink, Figma comment ID, PR URL,
  Linear issue, etc. This gives auditable provenance and lets re-running
  the same import deduplicate against existing entities.
alternatives:
  - name: No source pointer
    rejected_because: "Reviewers can't verify the extraction. Re-imports duplicate."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:31:00Z

created_at: 2026-05-08T15:31:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-043 — Each backfilled entity carries a `Reference` to its source

Reference: PLANNING.md §4.2.
