---
id: rule_01KR441EAMXCXF4FD1QTB1HTTS
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "Principal.display_name MUST NOT match an email regex — privacy guard for public Docos."

born_from: decision_01KR441EA8QFSX5Q6CHNVCKMJ0   # ADR-054 (Q#12 PII)
slug: pii-not-in-display-name
modality: must_not
severity: warning
phase: invariant
applies_to:
  node_type: principal
predicate: '{"op": "matches_regex", "left": {"path": "display_name"}, "right": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"}'
expected: false
on_violation: warn

created_at: 2026-05-08T17:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: active
scopes: []
---

# PII not in display_name

Resolves the privacy concern surfaced as DECISIONS.md §13 #12 and accepted
in ADR-054. Public Docos expose Principal.display_name through the
agent-ancestry chain (PLANNING.md §3.4); a display_name shaped like an
email leaks the user's address.

Implemented in [@doco/lints](../packages/lints/src/pii-display-name.ts);
this Rule entity makes the policy explicit and queryable. The predicate is
in JSON DSL (ADR-048) so the runtime check engine can evaluate it directly
without a hand-coded lint, once the engine wires the DSL evaluator into the
invariant phase (currently the lint package short-circuits with a TS regex —
follow-up to migrate it).
