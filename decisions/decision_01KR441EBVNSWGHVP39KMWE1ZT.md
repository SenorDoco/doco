---
id: decision_01KR441EBVNSWGHVP39KMWE1ZT
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Only humans can delete Evalos. A built-in system Rule blocks delete_evalo Actions when the actor is not human."

slug: only-humans-can-delete-evalos
number: "ADR-040"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "Are there any operations that should be human-only?"
chosen: |
  Yes — exactly one: `delete_evalo`. A built-in system Rule
  (`rule_system_only_humans_delete`, in this Evalo's schema as
  `rule_01KR441EAH8KJZ2F4TMP8YPQPB`) blocks the Action when the actor's
  Principal type is not `human`.

  Every other operation (create, edit, archive, transfer) is open to both
  humans and agents subject to Membership permissions.
alternatives:
  - name: All operations open to both kinds
    rejected_because: "Deletion is uniquely irreversible — its blast radius cannot be repaired by the alignment graph itself."
  - name: Many human-only operations
    rejected_because: "Conflicts with intent_01KR441EACJYB895DWKG7Z25SF (dual-user-model). Asymmetry should be exceptional and justified."
rules_consulted:
  - rule_01KR441EAH8KJZ2F4TMP8YPQPB   # only-humans-delete-evalo
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

# ADR-040 — Only humans can delete Evalos

Operationalized as
[rule_01KR441EAH8KJZ2F4TMP8YPQPB](../rules/rule_01KR441EAH8KJZ2F4TMP8YPQPB.md)
(only-humans-delete-evalo, `phase: pre`, `on_violation: block`).

Reference: PLANNING.md §2.4.
