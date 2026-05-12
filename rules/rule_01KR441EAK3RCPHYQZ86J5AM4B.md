---
id: rule_01KR441EAK3RCPHYQZ86J5AM4B
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "Every Decision tagged `tag_bugfix` should spawn at least one Rule tagged `tag_regression_guard` via `born_from`."

born_from: decision_01KR441EB8Q0VKHGMK7D1TV8T4   # ADR-021 (reserved tag conventions)
slug: bugfix-without-regression-guard
modality: should
severity: warning
phase: invariant
applies_to:
  any_of:
    - tag: tag_bugfix
predicate: |
  For every Decision D tagged `tag_bugfix`, there must exist a Rule R such
  that R is tagged `tag_regression_guard` and R.born_from == D.id.
expected: true
on_violation: warn

created_at: 2026-05-08T17:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: active
scopes: []
---

# Bug-fix without regression guard

Implemented in [@doco/lints](../packages/lints/src/bugfix-guard.ts).
A bug fix that doesn't spawn a guard against the bug recurring is missing
half of the alignment loop — fixing the symptom without preventing the
class. Convention from ADR-021 / D-016.
