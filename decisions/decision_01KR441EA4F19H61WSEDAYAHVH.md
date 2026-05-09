---
id: decision_01KR441EA4F19H61WSEDAYAHVH
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Schema versioning is additive within a major version. CLI warns on minor mismatch, errors on major mismatch."

slug: schema-versioning-policy
number: "ADR-050"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "How does Evalo handle schema evolution across versions?"
chosen: |
  Semver-like versioning of `schema_version`. Within a major version
  (e.g., `0.1` → `0.2` → `0.3`), only additive changes are allowed:
  new fields, new node types, new enum values. Existing data remains valid.

  CLI behavior on mismatch:
    - Same major, older minor in data:    silent (data is forward-compatible).
    - Same major, newer minor in data:    warning ("entity uses fields from a newer schema; some may be ignored").
    - Different major:                    error ("incompatible schema; run migration tool").

  Major bumps require an explicit Decision and a migration tool.
alternatives:
  - name: Strict additive forever (no major bumps)
    rejected_because: "Forecloses on breaking changes the project genuinely needs (e.g., a hard rename like principal → user)."
  - name: Implicit version (no field)
    rejected_because: "Forces consumers to infer version from field presence — fragile."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-050 — Schema versioning = additive within major; semver-shaped

Resolves [open question #4](../DECISIONS.md). Implemented in
`packages/core` schema validator (phase 1).
