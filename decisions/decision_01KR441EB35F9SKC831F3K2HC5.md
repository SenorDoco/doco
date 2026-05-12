---
id: decision_01KR441EB35F9SKC831F3K2HC5
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Any entity may carry `born_from: <other_entity_id>` for provenance ('X exists because of Y'); materialized as a `BornFrom` edge."

slug: born-from-as-generic-provenance
number: "ADR-016"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "How do we express 'X exists because of Y' (e.g., regression Rule born from a fix Decision)?"
chosen: |
  Any entity can carry a `born_from: <other_entity_id>` field. Materializes
  as a `BornFrom` edge in the index. Canonical use: regression-guard Rules
  `born_from` the bug-fix Decision; ADR-consequence Rules `born_from` the
  ADR Decision.
alternatives:
  - name: Per-relationship dedicated edge types
    rejected_because: "'BornFromBugfix', 'BornFromADR' etc. — pattern repeats; one generic edge with semantics filled in by the entity types themselves keeps the schema small."
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

# ADR-016 — `born_from` as a generic provenance edge

Reference: SCHEMA.md §3 (common field), §6 (edge), §6.1 (mapping).
