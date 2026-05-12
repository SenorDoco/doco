---
id: decision_01KR441EB9E6VBGNJGW6VQNVTM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Decisions can carry an optional `number: 'ADR-0042'` when promoted to ADR via `tag_adr`."

slug: optional-adr-number-on-decision
number: "ADR-022"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "How do ADR teams attach short, sequential identifiers to Decisions?"
chosen: |
  Decisions carry an optional `number: "ADR-0042"` field, set when `tag_adr`
  is applied. ULIDs remain the canonical ID; the ADR number is a human-side
  shorthand for ADR-using teams.
alternatives:
  - name: Force every Decision to be sequentially numbered
    rejected_because: "Most Decisions aren't ADRs; forcing the number creates noise and coordination."
  - name: Skip ADR numbers altogether (humans use the slug)
    rejected_because: "ADR teams have years of muscle memory around 'ADR-0042'-style references; supporting it costs little."
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

# ADR-022 — Optional `number` on Decision (ADR-style)

The 45 design decisions migrated from DECISIONS.md all carry `tag_adr` and
ADR-001..ADR-045 as a worked example.

Reference: SCHEMA.md §4.5.
