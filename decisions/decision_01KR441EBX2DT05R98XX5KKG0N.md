---
id: decision_01KR441EBX2DT05R98XX5KKG0N
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Backfill workflow: importers extract candidate entities, all entering with `lifecycle: proposed`. Review UI bulk-accepts/rejects; only on accept do they flip to `active`."

slug: backfill-with-proposed-quarantine
number: "ADR-042"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How do extracted entities from Slack / email / code enter the alignment graph without polluting it with bad data?"
chosen: |
  Importers (Slack, email, Figma, Notion, code, transcripts) extract
  candidate entities; all enter with `lifecycle: proposed`. A review UI
  bulk-accepts/rejects. Only on accept do entities flip to `active` (or
  `accepted` for Decisions).

  Importer pipelines are idempotent: re-running with the same scope
  produces the same proposed entities (D-043 makes them traceable back).
alternatives:
  - name: Direct ingest into `active`
    rejected_because: "Extracted entities are lossy and sometimes wrong. Forces unreviewed bad data into the live alignment graph."
  - name: No backfill at all
    rejected_because: "Forecloses brownfield adoption; the backfilled context is what makes Evalo useful for established projects."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:31:00Z

created_at: 2026-05-08T15:31:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-042 — Backfill workflow with `proposed` quarantine

Quarantine prevents bad data from entering the live alignment graph. Provides
a clear "complete-baseline" event when a user marks backfill as complete.

Reference: PLANNING.md §4.
