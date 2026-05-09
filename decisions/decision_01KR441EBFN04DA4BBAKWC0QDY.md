---
id: decision_01KR441EBFN04DA4BBAKWC0QDY
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Four scope cases via three mechanisms: global (`{all: true}`), local sub-scope (`scope_*` tag), hierarchical (deferred), cross-Evalo (`imports`)."

slug: four-scope-cases-three-mechanisms
number: "ADR-028"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "How does Evalo express scoping at four levels (global, local, hierarchical, cross-Evalo) without bloating the schema?"
chosen: |
  - **Global within Evalo** — `applies_to: { all: true }`.
  - **Local sub-scope** — reserved `scope_*` tag prefix (`scope_auth`, `scope_payments`, ...).
  - **Hierarchical scopes** — *deferred*; promote `Scope` to first-class entity only if the tag-only model proves insufficient.
  - **Cross-Evalo** — `imports` field in `evalo.yaml` (D-029).
alternatives:
  - name: First-class Scope entity from day one
    rejected_because: "Premature complexity. Tag-prefix convention covers ~all the cases people actually need; promote only on demonstrated insufficiency."
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

# ADR-028 — Four scope cases, three mechanisms

Reference: SCHEMA.md §9.
