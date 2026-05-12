---
id: decision_01KR441EB8Q0VKHGMK7D1TV8T4
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Six reserved tag names with semantic meaning: tag_adr, tag_bugfix, tag_regression_guard, tag_adr_consequence, tag_userflow, plus the scope_* prefix."

slug: reserved-tag-conventions
number: "ADR-021"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "How does Doco encode 'this Decision is an ADR' or 'this Rule guards a fix' without proliferating entity types?"
chosen: |
  Reserved tag names with semantic meaning recognized by tooling/lints:
    - `tag_adr` — Decision is published as an ADR (sets `number` field).
    - `tag_bugfix` — Decision resolves a bug; expected to spawn a `tag_regression_guard` Rule.
    - `tag_regression_guard` — Rule born from a bugfix Decision.
    - `tag_adr_consequence` — Rule born from an ADR's stated consequence.
    - `tag_userflow` — Decision is part of a user-flow design chain.
    - `scope_*` — local sub-scope (used in `applies_to` selectors).
alternatives:
  - name: New entity types for each pattern (BugfixDecision, ADR, RegressionGuard, ...)
    rejected_because: "Entity-type proliferation. Tags are flexible categorization; reserved names give them semantic teeth without expanding the schema."
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

# ADR-021 — Reserved tag conventions

Lints can enforce conventions — e.g., "every `tag_bugfix` Decision must have
at least one `BornFrom` edge from a `tag_regression_guard` Rule."

Reference: SCHEMA.md §4.10 (Tag).
