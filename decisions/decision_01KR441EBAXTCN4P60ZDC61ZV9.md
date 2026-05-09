---
id: decision_01KR441EBAXTCN4P60ZDC61ZV9
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Tiered architecture: source files (git-tracked, authoritative) plus a per-clone derived index at .evalo/cache.db (regenerable, not source-of-truth)."

slug: tiered-architecture-source-and-derived-index
number: "ADR-023"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How does Evalo combine readable source files with fast queries at scale?"
chosen: |
  Source files (`intents/`, `rules/`, ...) are git-tracked and authoritative.
  A local `.evalo/cache.db` SQLite index is per-clone, regenerable, *not*
  git-tracked. Wiping the index never loses data; each clone rebuilds locally.
alternatives:
  - name: Derived index in source-of-truth (committed cache.db)
    rejected_because: "Binary diff hell on commit. Per-clone divergence with no good merge story."
  - name: No index — every query reads source
    rejected_because: "Linear in entity count. At 10k entities, a single query becomes painful."
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

# ADR-023 — Tiered architecture: source files + derived index

`.evalo/` is in `.gitignore` of this Evalo. `evalo reindex` rebuilds in
seconds at 10k.

Reference: SCHEMA.md §8.1.
