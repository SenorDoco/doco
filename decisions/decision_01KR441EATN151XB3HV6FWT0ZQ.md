---
id: decision_01KR441EATN151XB3HV6FWT0ZQ
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Six canonical lifecycle states across all stateful entities: proposed → active → succeeded | superseded | abandoned | failed."

slug: canonical-lifecycle
number: "ADR-007"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "How do entity lifecycles work across kinds with different vocabularies?"
chosen: |
  Six canonical lifecycle states: `proposed → active → succeeded | superseded
  | abandoned | failed`. Each kind keeps a `status` alias (e.g., Intent uses
  "achieved" for `succeeded`), but the underlying `lifecycle` value is one of
  the six. Tooling and queries use `lifecycle` as the canonical key; UI renders
  the alias.
alternatives:
  - name: Per-kind status enums only
    rejected_because: "Synonym sprawl — 'achieved' for Intent, 'accepted' for Decision, 'completed' for Action — makes 'show me everything currently active' a multi-query mess."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-007 — Canonical lifecycle across all stateful entities

| Entity | proposed | active | succeeded | superseded | abandoned | failed |
|---|---|---|---|---|---|---|
| Intent | proposed | active | achieved | deprecated | abandoned | — |
| Decision | proposed | active | accepted | superseded | reverted | — |
| Action | planned | in_progress | completed | — | blocked | failed |
| Rule | proposed | active | — | superseded | retired | — |

Reference: SCHEMA.md §3.1.
