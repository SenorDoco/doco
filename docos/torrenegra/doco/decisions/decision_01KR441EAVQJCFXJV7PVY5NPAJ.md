---
id: decision_01KR441EAVQJCFXJV7PVY5NPAJ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Each Doco records its own schema_version. Evolution is additive (new fields don't invalidate old data); breaking changes require explicit version bump."

slug: per-doco-schema-version
number: "ADR-008"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "How do schema upgrades propagate across Docos?"
chosen: |
  Each Doco records `schema_version`. Schema evolution is additive (new
  fields don't invalidate old data); breaking changes require an explicit
  version bump. Cross-Doco tooling has to handle multiple versions.
alternatives:
  - name: Single global schema, additive-only forever
    rejected_because: "Forecloses on breaking changes the project might genuinely need. Open question DECISIONS.md §13 #4 — may revisit."
  - name: Implicit schema (no version field)
    rejected_because: "Forces consumers to infer version from field presence/absence — fragile."
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

# ADR-008 — Per-Doco `schema_version` (additive evolution)

Open: whether to allow only-additive forever vs explicit migrations
(DECISIONS.md §13 #4).

Reference: SCHEMA.md §3, §11.
