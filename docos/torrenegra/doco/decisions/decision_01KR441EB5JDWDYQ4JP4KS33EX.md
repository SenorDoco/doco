---
id: decision_01KR441EB5JDWDYQ4JP4KS33EX
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Each node kind has a stable, human-readable handle alongside its ULID — slug, username, locator, name."

slug: per-node-handle-field
number: "ADR-018"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "Do humans navigate by ULID alone, or do entities carry human-readable handles?"
chosen: |
  Each node kind has a stable, human-readable handle alongside its ULID.
  Conventions:
    - `Principal.username` — GitHub login (humans) or `{owner_username}/{ISO_timestamp}` (agents).
    - `Doco.slug` — `{owner_username}/{doco_name}`.
    - `Intent / Rule / Decision`: `slug` (kebab-case, derived from primary content, deduped).
    - `Reference.locator` — the external URL/path itself.
    - `Tag.name` — kebab-case prefixed with conventions (`tag_*`, `scope_*`).
    - `Action / Reasoning / Evaluation` — *no slug*; refer by ID.
alternatives:
  - name: ULID-only navigation
    rejected_because: "Humans cannot remember `decision_01KR441EAMKYKCEBSEYHGJ8M3Z`. Slugs serve priority 3."
  - name: Slugs on every entity including Action/Reasoning/Evaluation
    rejected_because: "Transient or event-shaped entities don't have natural slugs. Forcing one creates noise."
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

# ADR-018 — Per-node handle field

Reference: SCHEMA.md §7.
