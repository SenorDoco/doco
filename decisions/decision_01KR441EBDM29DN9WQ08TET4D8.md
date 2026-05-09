---
id: decision_01KR441EBDM29DN9WQ08TET4D8
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "When a Rule's applies_to selector changes, evaluate it once and store matches in `scope_match`. Lookups become a single index hit."

slug: denormalized-scope-match
number: "ADR-026"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "How do we make 'which Rules apply to this entity?' fast?"
chosen: |
  Denormalize. When a Rule is created or its `applies_to` selector changes,
  evaluate once and store matches in `scope_match` table; bump `selector_rev`.
  When a new entity is created, evaluate active selectors against it once.
  Lookups become O(1).
alternatives:
  - name: Evaluate selectors on every read
    rejected_because: "Linear in selectors × entities. Slow at scale, especially for runtime-checking-intensive workflows."
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

# ADR-026 — Denormalized scope-selector caching

Rules are read-heavy and rarely change; pay once on write.

Reference: SCHEMA.md §8.5.
