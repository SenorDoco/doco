---
id: decision_01KR441EB68799CQN8XTBZKQMH
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Slugs are immutable once set. Editing title/summary does not regenerate the slug; renames create a new slug with the old becoming an alias."

slug: slugs-are-immutable
number: "ADR-019"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "What happens to slugs when an entity's title or summary changes?"
chosen: |
  Editing the title or summary does *not* regenerate the slug. Renames
  create a new slug; the old becomes an alias and continues to resolve.
  This guarantees URL stability and cross-reference robustness.
alternatives:
  - name: Slugs auto-regenerate from current title
    rejected_because: "Breaks every existing reference each time a title is wordsmithed. Stable handles must be stable."
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

# ADR-019 — Slugs are immutable once set
