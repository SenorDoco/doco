---
id: intent_01KR441EAD70XGG1TS53WT8JM2
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Every design tradeoff is resolved in favor of AI agent comprehension first; then agent updates, then human comprehension, then scoping, version control, performance, issue detection."

slug: agent-comprehension-first
title: Optimize the schema for AI agent comprehension before all else
priority: p0
parent_intent_id: intent_01KR441EA92V53H22ZN087YMRM

non_goals:
  - Make Doco unreadable for humans. The priority order is strict, but where both audiences can be served, both should be.
  - Lock in a particular AI model's quirks. Agent-comprehension means agent-class fluency in 2026 and beyond, not model-X-fluency in May 2026.

acceptance:
  - Every design Decision cites the priority order and identifies which priorities trade off (rule_01KR441EAF7M5QPF65BXGD1ET1).
  - "Schema fields are predictable, named consistently, and self-describing (`node_type` discriminator on every entity, `schema_version` on every entity)."
  - "The schema for the Doco is embedded inside the Doco (`schema/doco.schema.json`) so an agent can introspect without external context."

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

# Optimize for agent comprehension before all else

Doco's strict-priority order:

1. AI agent comprehension
2. AI agent updates
3. Human comprehension
4. Scoping
5. Version control
6. Performance
7. Automated identification of issues

The deliberate, surprising claim here is **#1 above #3**: when the two
diverge, schema choices favor what is parseable by agents. This is why
fields are explicit (not inferred), IDs are prefixed by type, the schema
is embedded in the Doco, and SQL is the primary query surface (D-027).

The rule that operationalizes this priority order is
rule_01KR441EAF7M5QPF65BXGD1ET1.
