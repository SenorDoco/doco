---
id: decision_01KR441EBK4VVQN19Q8AHYV8D0
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "`glossary.yaml` is a flat config file at the Doco root, not a node type. Term → synonyms expansion for Rule discovery."

slug: glossary-as-flat-config
number: "ADR-032"
intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "How does Doco handle vocabulary mismatch between Rule authors and downstream callers?"
chosen: |
  Optional `glossary.yaml` at Doco root with term → synonyms mapping. Used
  by Rule discovery's semantic-search step. Not a node type.
alternatives:
  - name: First-class GlossaryEntry entity
    rejected_because: "Per-term version control isn't yet a need. Promote to entity if it becomes valuable."
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

# ADR-032 — `glossary.yaml` as flat config

Reference: SCHEMA.md §10.2. See also [glossary.yaml](../glossary.yaml).
