---
id: decision_01KR441EAY946TF9J62FAKCA57
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Membership is an edge property on Doco.members[], not its own entity. Reduces node-type count from 11 to 10."

slug: membership-as-edge-not-node
number: "ADR-011"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "Is Membership a first-class entity or an edge?"
chosen: |
  `Doco.members[]` carries `{principal_id, role, permissions}` structs. The
  index materializes these as `MemberOf` edges with role and permissions as
  edge properties. Graph-native; aligns with Kuzu mapping if/when we adopt
  it (D-024).
alternatives:
  - name: First-class Membership entity with its own ID and lifecycle
    rejected_because: "No genuine independent lifecycle worth a separate node. Membership rarely changes between create and revoke; the few transitions can be tracked as Actions."
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

# ADR-011 — Membership as edge, not node

Reference: SCHEMA.md §4.2 (Doco entity), §6.1 (fields-as-edges convention).
