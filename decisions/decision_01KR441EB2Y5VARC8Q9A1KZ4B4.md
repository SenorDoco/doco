---
id: decision_01KR441EB2Y5VARC8Q9A1KZ4B4
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Drop the `Bounded_by` edge; use only `AppliesTo` (Rule → entity). Graph traversal works in either direction."

slug: drop-bounded-by-edge
number: "ADR-015"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "Do we need an inverse `Bounded_by` edge to complement `AppliesTo`?"
chosen: |
  Use `AppliesTo` (Rule → entity) only. Don't model the inverse Action-side
  `Bounded_by` separately. The index supports traversal in both directions.
alternatives:
  - name: Keep both `AppliesTo` and `Bounded_by`
    rejected_because: "Convenience only; one edge type is enough."
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

# ADR-015 — Drop `Bounded_by` edge

Reference: SCHEMA.md §6.
