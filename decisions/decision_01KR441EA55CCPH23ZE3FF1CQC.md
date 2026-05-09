---
id: decision_01KR441EA55CCPH23ZE3FF1CQC
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Drop `conclusion_node_type` from Reasoning — redundant with `conclusion_ref`'s ID prefix."

slug: drop-conclusion-node-type
number: "ADR-051"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "Should Reasoning carry both `conclusion_node_type` and `conclusion_ref`?"
chosen: |
  Drop `conclusion_node_type`. The `conclusion_ref` value is `<node_type>_<ulid>`
  (D-004) — the prefix already encodes the node type. Two fields holding the
  same fact is duplication that drifts.
alternatives:
  - name: Keep both fields
    rejected_because: "Genuine duplication. The prefix on `conclusion_ref` is already authoritative."
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

# ADR-051 — Drop `conclusion_node_type` from Reasoning

Resolves [open question #10](../DECISIONS.md). Schema bumped from 0.1 to 0.1.1
(additive: removing an optional field is non-breaking for readers; writers
should stop emitting it).

The existing reasoning entity
([reasoning_01KR441EC28S1517BVHDM774ZJ](../reasoning/reasoning_01KR441EC28S1517BVHDM774ZJ.md))
had this field on bootstrap; it has been removed.
