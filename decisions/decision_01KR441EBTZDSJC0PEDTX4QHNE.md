---
id: decision_01KR441EBTZDSJC0PEDTX4QHNE
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Token *values* live in the API server's encrypted database. The Evalo records *which* Principals exist and the lineage; tokens are never in git."

slug: tokens-stored-externally
number: "ADR-039"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "Where do token values live?"
chosen: |
  External — the API server's encrypted database. The Evalo records *which*
  Principals exist and their lineage; the index reflects edges. Token values
  must not appear in git.
alternatives:
  - name: Tokens in the Evalo
    rejected_because: "Source-controlled secrets are bad practice. Tokens shouldn't be in git, period."
  - name: First-class Token entity inside the Evalo
    rejected_because: "Currently kept external. Promote to entity only if Evalo-internal queries on token *metadata* (name, scope, revocation history) become valuable (DECISIONS.md §13 #8). Token *values* still live elsewhere."
rules_consulted:
  - rule_01KR441EAK6MKGDZZWH5TRZ9HQ   # no-secrets-in-evalo
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

# ADR-039 — Tokens are stored externally, not in the Evalo

Operationalized as
[rule_01KR441EAK6MKGDZZWH5TRZ9HQ](../rules/rule_01KR441EAK6MKGDZZWH5TRZ9HQ.md)
(no-secrets-in-evalo, `phase: pre`).

Reference: PLANNING.md §3.3.
