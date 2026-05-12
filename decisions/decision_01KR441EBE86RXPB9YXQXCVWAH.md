---
id: decision_01KR441EBE86RXPB9YXQXCVWAH
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Agents query the index via SQL. The schema is self-describing via schema/doco.schema.json. No custom DSL; no Cypher."

slug: sql-is-primary-query-surface
number: "ADR-027"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
  - intent_01KR441EAEM5NQBM160763TDDT
question: "What query language do agents and humans use?"
chosen: |
  SQL. The index schema is self-describing via `schema/doco.schema.json`
  embedded in every Doco. SQL is universally trained; no DSL for an agent
  to learn. A future high-level NL → SQL helper is welcome but not the
  primary surface.
alternatives:
  - name: Custom Doco DSL
    rejected_because: "One more thing to teach. Agents already speak SQL; spend the complexity budget elsewhere."
  - name: Cypher only
    rejected_because: "Agents stumble on Cypher noticeably more than on SQL (priority 1)."
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

# ADR-027 — SQL is the primary agent query surface

Reference: SCHEMA.md §8.6.
