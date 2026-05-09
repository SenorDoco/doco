---
id: decision_01KR441EAZ9KR2BE2QY84S301E
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Reasoning is a first-class entity, not a `rationale` string on Decision/Action. Multiple reasonings can attach to one decision."

slug: reasoning-is-first-class
number: "ADR-012"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "Is Reasoning its own entity or a field on Decision/Action?"
chosen: |
  Reasoning lives in its own file with `premises`, `inference`, `confidence`,
  `uncertainty` fields. Multiple Reasonings can attach to the same Decision
  (different authors, contested reasoning, post-hoc revision).
alternatives:
  - name: Collapse Reasoning into a `rationale` string on Decision/Action
    rejected_because: "Loses multi-author critique, contested reasoning, and the ability to query reasoning chains independent of conclusions. All target use cases."
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

# ADR-012 — Reasoning is a first-class entity (multi-author capable)

Reference: SCHEMA.md §4.7.
