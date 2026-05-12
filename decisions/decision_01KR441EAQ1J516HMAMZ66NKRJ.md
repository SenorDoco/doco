---
id: decision_01KR441EAQ1J516HMAMZ66NKRJ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "IDs are '{node_type}_{ULID}' — type prefix + Crockford ULID. Time-sortable, no central coordination."

slug: ids-are-node-type-prefixed-ulid
number: "ADR-004"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "What format do entity IDs take?"
chosen: |
  Every entity ID is `{node_type}_{ULID}`, e.g., `intent_01H8XYZ...`. ULIDs
  sort by creation time, are URL-safe, need no central coordinator. The
  node_type prefix lets agents identify the type from the ID alone.
alternatives:
  - name: UUIDv4
    rejected_because: "No time order; longer; opaque to humans without context."
  - name: Auto-increment per Doco
    rejected_because: "Forces coordination on writes — bad for agent updates (priority 2). Concurrent agents would collide."
  - name: Content hash
    rejected_because: "Mutates on every edit; breaks references (priority 4 scoping)."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-004 — IDs = `{node_type}_{ULID}`

Reference: SCHEMA.md §7.
