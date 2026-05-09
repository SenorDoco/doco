---
id: rule_01KR441EAF7M5QPF65BXGD1ET1
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "Design tradeoffs follow Evalo's strict priority order; conflicts must be surfaced as Decisions."

born_from: decision_01KR441EAMKYKCEBSEYHGJ8M3Z   # ADR-001 (priority order)
slug: priority-order
modality: must
severity: blocker
phase: declared
applies_to:
  any_of:
    - tag: scope_meta
    - { node_type: decision }
predicate: |
  Every Decision that trades one priority against another must explicitly
  identify which priorities trade off and choose in priority order.
expected: true
on_violation: warn

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: active
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Design tradeoffs follow the priority order

Whenever a design decision requires trading off two of the following concerns,
choose the one earlier in this list:

1. AI agent comprehension
2. AI agent updates
3. Human comprehension
4. Scoping
5. Version control
6. Performance
7. Automated identification of issues

If you find yourself trading off priority N for priority N+k where k > 0,
**stop and surface the tradeoff in a `decision` entity** rather than resolving
it silently.

Notably: agent comprehension > human comprehension, and performance is sixth —
Evalo prefers explicit, queryable structure over runtime speed.

## Predicate language

For v0.1, this Rule is `phase: declared` (always-holds policy). A machine-
checkable form will arrive when the predicate language for Rules is settled
(DECISIONS.md §13 #1). At that point, the predicate would assert that every
Decision touching schema/storage/API/UX has at least one `priorities_traded`
field naming the priorities involved.
