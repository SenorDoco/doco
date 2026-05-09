---
id: decision_01KR441EBC9QWZVT240Q78R021
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Edges materialized as a single adjacency table: `edges(from_id, from_node_type, to_id, to_node_type, edge_type)`. Recursive CTEs for traversal."

slug: edges-as-adjacency-table
number: "ADR-025"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How are edges stored in the SQLite index?"
chosen: |
  Single `edges(from_id, from_node_type, to_id, to_node_type, edge_type)`
  table. Recursive CTEs for traversal. Standard relational-graph pattern;
  works to ~1M edges; simple to reason about.
alternatives:
  - name: One edge table per edge type
    rejected_because: "10+ edge types means 10+ tables to UNION across. Defeats the purpose of relational uniformity."
  - name: Edges embedded as columns on each node table
    rejected_because: "Forces schema migration each time a new edge type is added; loses adjacency-table queryability."
rules_consulted: []
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

# ADR-025 — Edges as adjacency table

Reference: SCHEMA.md §8.2.
