---
id: decision_01KR441EB4D3NMVGJYJX5PHQZF
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Any field whose value is an entity ID (or list of IDs) is automatically materialized as an edge in the index. Field name → edge type."

slug: fields-as-edges
number: "ADR-017"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "How do we keep the entity files (source-of-truth) and the edge graph (queryable) in lockstep?"
chosen: |
  Convention: any field on an entity whose value is an entity ID (or list
  of IDs) is automatically materialized as an edge in the index, with the
  field name mapping to the edge type. The frontmatter file is the
  source-of-truth; the index re-derives edges on each update.
alternatives:
  - name: Separate edge schema document
    rejected_because: "Two sources of truth (entity fields + edge schema) drift. Source-of-truth entity fields with auto-derivation makes adding a new ID-valued field automatically index-pickup-able."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-017 — Fields-as-edges convention

This is what keeps the source-of-truth files and the queryable graph in
lockstep. Adding a new ID-valued field automatically gets it picked up by
the index — agents reading the schema can infer the edge graph without a
separate edge-schema document.

Reference: SCHEMA.md §6.1 (full mapping table).
