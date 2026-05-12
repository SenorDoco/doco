---
id: decision_01KR441EAS39KJC9RN9WCD648W
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Every entity carries the same common field set: id, doco_id, node_type, schema_version, summary, created_at/by, updated_at/by, revision, lifecycle, status, tags, and optional born_from."

slug: common-fields-on-every-entity
number: "ADR-006"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "What fields are guaranteed on every entity?"
chosen: |
  `id`, `doco_id`, `node_type`, `schema_version`, `summary`, `created_at`,
  `created_by`, `updated_at`, `updated_by`, `revision`, `lifecycle`, `status`,
  `tags`, `born_from` (optional). These are the API surface every consumer
  can rely on.
alternatives:
  - name: Per-kind ad-hoc field sets
    rejected_because: "Forces every consumer to special-case each kind. Loses the cross-kind queryability of `lifecycle`."
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

# ADR-006 — Common fields on every entity

`summary` serves human-readability (priority 3). `lifecycle` standardizes
state across all stateful entities (D-007).

Reference: SCHEMA.md §3.
