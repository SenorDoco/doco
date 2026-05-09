---
id: decision_01KR441EARA83PWX3JVA1MGK3F
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Discriminator field on every entity is `node_type`. The umbrella noun for entities is 'node'."

slug: discriminator-field-is-node-type
number: "ADR-005"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "What field name discriminates between entity kinds?"
chosen: |
  Every entity has a `node_type` field. "Node" is the umbrella noun.
  This aligns with the graph framing of Evalo's data model.
alternatives:
  - name: kind
    rejected_because: "Unclear — 'kind of what?'. Reads ambiguously without context."
  - name: type
    rejected_because: "Collides with `Principal.type` (`human` | `agent`). Two unrelated enum spaces sharing a field name is a footgun."
  - name: entity_type
    rejected_because: "More verbose; less aligned with the graph framing where entities are nodes."
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

# ADR-005 — Discriminator field is `node_type`

Reference: SCHEMA.md §3 + every §4 entity.
