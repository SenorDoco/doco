---
id: rule_01KR441EAJCPF378ZGM9DMDFH0
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "Every agent's owner_id chain terminates at a human Principal — the trust invariant."

born_from: decision_01KR441EBPZB0X7K59C411PHAQ   # ADR-035 (agents via invitation only)
slug: agent-ancestry-terminates-at-human
modality: must
severity: blocker
phase: invariant
applies_to:
  node_type: principal
  type: agent
predicate: |
  For every Principal where type == 'agent', following the OwnedBy edge chain
  (agent.owner_id → ...) must reach a Principal with type == 'human' in a
  finite number of steps. No agent may have an ancestry chain ending in
  another agent or in a cycle.
expected: true
on_violation: block

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: active
scopes: []
---

# Agent ancestry chain terminates at a human

This is the **core trust property** of Doco's identity model (PLANNING.md
§2.2, §3.4 / D-035). Every agent Principal traces back, via `owner_id`, to a
human Principal in a finite number of steps.

Without this invariant, an agent could spawn agents that spawn agents
indefinitely with no human accountability. With it, accountability for any
action by any agent has a finite chain ending at a real, GitHub-verified human.

## Querying the chain

```cypher
// Cypher (graph DB form — D-024 swap target)
MATCH path = (a:Principal {type: 'agent'})-[:OwnedBy*]->(human:Principal {type: 'human'})
WHERE a.id = $agent_id
RETURN path
```

Or, equivalently, in the SQLite `edges` adjacency table (D-025):

```sql
WITH RECURSIVE chain(from_id, to_id, depth) AS (
  SELECT from_id, to_id, 1 FROM edges
  WHERE from_id = :agent_id AND edge_type = 'owned_by'
  UNION ALL
  SELECT c.from_id, e.to_id, c.depth + 1
  FROM chain c JOIN edges e ON e.from_id = c.to_id
  WHERE e.edge_type = 'owned_by' AND c.depth < 100
)
SELECT EXISTS (
  SELECT 1 FROM chain c
  JOIN principal p ON p.id = c.to_id
  WHERE p.type = 'human'
);
```

A periodic lint asserts the invariant for every agent in the principal table.
