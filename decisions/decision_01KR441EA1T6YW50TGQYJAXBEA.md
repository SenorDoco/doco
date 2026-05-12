---
id: decision_01KR441EA1T6YW50TGQYJAXBEA
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "License is Apache 2.0 — permissive, business-friendly, includes a patent grant."

slug: license-apache-2
number: "ADR-047"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "What license does the open-source Doco codebase carry?"
chosen: "Apache License 2.0."
alternatives:
  - name: MIT
    rejected_because: "No patent grant; weaker defense if the project accumulates patentable algorithms."
  - name: AGPL-3
    rejected_because: "Hostile to internal/embedded use by the very dev teams Doco is targeting."
  - name: Commercial / proprietary
    rejected_because: "Conflicts with intent_01KR441EACJYB895DWKG7Z25SF (dual-user-model implies broad access) and would chill adoption."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-047 — License = Apache 2.0

`LICENSE` file at the repo root carries the canonical Apache-2.0 text.
