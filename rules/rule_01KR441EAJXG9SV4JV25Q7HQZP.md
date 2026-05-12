---
id: rule_01KR441EAJXG9SV4JV25Q7HQZP
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "Every Reasoning entity must have a `conclusion_ref` that resolves to a real entity — no orphans."

born_from: decision_01KR441EAZ9KR2BE2QY84S301E   # ADR-012 (Reasoning is first-class)
slug: orphan-reasoning
modality: must
severity: warning
phase: invariant
applies_to:
  node_type: reasoning
predicate: |
  Reasoning.conclusion_ref MUST be a non-null EntityId that resolves to a
  loaded entity in this Doco. Orphan Reasonings — no conclusion or pointing
  to a missing target — fail this Rule.
expected: true
on_violation: warn

created_at: 2026-05-08T17:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: active
scopes: []
---

# Orphan-Reasoning lint as a Rule

Implemented in [@doco/lints](../packages/lints/src/orphan-reasoning.ts);
this Rule entity makes the policy explicit and queryable. The lint runs on
every `doco lint` and on the web's `/lint` page.

Reasoning entities are first-class precisely so multi-author critique is
possible (ADR-012). An orphan defeats that purpose — the conclusion the
reasoning is supposedly *about* doesn't exist.
