---
id: decision_01KR441EBMZYHYKE0RMVCKY3RN
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Rule discovery: structural matches block runtime; tag/reference/semantic matches are advisory only."

slug: hard-soft-separation-in-discovery
number: "ADR-033"
intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "Which discovery strategies are allowed to block an Action?"
chosen: |
  Structural matches (strategies 1-3) *block* — the runtime gate stays
  precision-tight, no false positives. Tag/reference/semantic matches
  (strategies 4-5) are *advisory* — surfaced as context, never enforced.
alternatives:
  - name: All strategies block
    rejected_because: "Semantic search false positives would block work; agents would lose trust."
  - name: All strategies advisory
    rejected_because: "Loses the runtime gate; misalignment ships."
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

# ADR-033 — Hard/soft separation in discovery

Runtime gate stays precise. Discovery layer stays generous.

Reference: SCHEMA.md §10.1.
