---
id: rule_01KR441EAH8KJZ2F4TMP8YPQPB
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "System Rule (built-in, ships with Doco): only human Principals may delete Docos."

born_from: decision_01KR441EBVNSWGHVP39KMWE1ZT   # ADR-040 (only humans delete Docos)
slug: only-humans-delete-doco
modality: must
severity: blocker
phase: pre
applies_to:
  node_type: action
  verb: delete_doco
predicate: '{"op": "eq", "left": {"path": "actor.type"}, "right": "human"}'
expected: true
on_violation: block

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: active
scopes: []
---

# Only humans may delete Docos

This is the canonical built-in **system Rule** shipped with Doco (PLANNING.md
§2.4 / D-040). It ships with every Doco and is not user-editable.

The motivation is asymmetry of consequence: deletion of an Doco is the only
operation in the system whose blast radius cannot be undone via the alignment
graph itself. Every other operation (create, edit, archive, transfer) is open
to both humans and agents subject to Membership permissions.

## Implementation note

In the schema as currently written, `actor.type == 'human'` references the
Principal's `type` field (`human` | `agent`). DECISIONS.md §13 #2 has an open
question about renaming this to `is_agent: bool`; if that rename happens,
this predicate becomes `actor.is_agent == false` and this Rule must be
updated.
