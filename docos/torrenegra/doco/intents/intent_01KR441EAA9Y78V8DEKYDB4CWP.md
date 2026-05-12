---
id: intent_01KR441EAA9Y78V8DEKYDB4CWP
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Verify alignment at runtime: must-rules are checked before actions take effect, not only audited after."

slug: runtime-checking
title: Verify Rules at runtime
priority: p1
parent_intent_id: intent_01KR441EA92V53H22ZN087YMRM

non_goals:
  - Be a static analyzer. Static is welcome but not the primary mode.
  - Replace runtime monitoring tools. We integrate, not compete.

acceptance:
  - "At Action time, a `pre`/`invariant`-phase Rule whose `applies_to` matches the Action is evaluated."
  - "`must` violations with `on_violation: block` prevent the Action from taking effect."
  - "Each runtime check produces an `Evaluation` entity (append-only, partitioned by month)."
  - "The check loop is fast enough not to be skipped: sub-10ms per Action at 10k entities."

stakeholders:
  - principal_01KR441EA199MZCP7RDMADFZW9

applies_to:
  any_of:
    - tag: scope_meta

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Verify Rules at runtime

The framework is not just documentation. An Doco's Rules — especially those
with `phase: pre | invariant` — are checked at runtime, so misalignment is
caught before Actions take effect rather than only audited after.

This is what distinguishes Doco from a typical ADR repository. Every Action
is gated by the matching `must` Rules in its scope; violations block (default)
or warn, and produce queryable `Evaluation` records.

See SCHEMA.md §4.4 (Rule), §4.8 (Evaluation), §10 (Rule discovery — finding
the right Rules to evaluate against a given Action).
