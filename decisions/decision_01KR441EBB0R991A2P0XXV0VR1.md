---
id: decision_01KR441EBB0R991A2P0XXV0VR1
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Index = SQLite + FTS5. Recursive CTEs for graph traversal. Kuzu deferred — swap if profiling shows recursive-CTE traversal as the bottleneck."

slug: index-is-sqlite-plus-fts5
number: "ADR-024"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
  - intent_01KR441EAEM5NQBM160763TDDT
question: "What database backs the local query index?"
chosen: |
  SQLite with FTS5 virtual table for full-text. Recursive CTEs for graph
  traversal. Embedded, zero-ops, universally trained — agents are vastly
  more fluent in SQL than in Cypher.
alternatives:
  - name: Kuzu (embedded graph DB, native Cypher)
    rejected_because: "Newer (less battle-tested), C++ deps, smaller ecosystem. Strongest swap target if SQL recursive CTEs become the bottleneck."
  - name: Memgraph / Neo4j (server-based graph DBs)
    rejected_because: "Separate server, ops cost; overkill at v0.x scale."
  - name: TerminusDB (git-like branching on a graph DB)
    rejected_because: "Conceptually aligned but would replace files-as-source-of-truth — much bigger architectural commitment. Revisit only if we ever go DB-as-source-of-truth."
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

# ADR-024 — Index = SQLite + FTS5 (Kuzu deferred)

**Dominant factor**: priority 1 (agent comprehension). SQL appears in orders
of magnitude more agent training data than Cypher.

**When to revisit**: profiling at real scale (1M+ entities, 5+ hop traversals)
shows recursive-CTE traversal as the bottleneck → swap to Kuzu. Index is
rebuildable from source, so the swap is engineering, not data migration.

Reference: SCHEMA.md §8.2, §8.8.
