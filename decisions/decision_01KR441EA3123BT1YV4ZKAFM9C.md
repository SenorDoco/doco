---
id: decision_01KR441EA3123BT1YV4ZKAFM9C
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "v0 scale target is Tier B: 1k-100k entities per Doco, ≤1M edges; sub-second runtime checks at the upper bound; all analytics in-process."

slug: v0-scale-target-tier-b
number: "ADR-049"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "What scale (entities, edges, latency budgets) does Doco target for v0.x?"
chosen: |
  **Tier B**: 1k-100k entities per Doco, ≤1M edges (~5-10× entity count),
  sub-second per runtime check at the upper bound, single-digit ms for
  one-hop queries, single-digit seconds for full-Doco PageRank/centrality
  in-process via igraph or NetworkX.

  Scaling above Tier B is explicitly out of v0 scope. The D-024 swap-trigger
  framing ("1M+ entities, 5+ hop traversals") is the *trigger to revisit*,
  not the *target*.
alternatives:
  - name: Tier A — ≤1k entities (greenfield year 1 only)
    rejected_because: "Forecloses brownfield-import use case (D-042) which is half of real adoption."
  - name: Tier C — 100k-1M entities
    rejected_because: "Demands engineering for in-memory edge sets approaching ~500MB and PageRank passes in tens of seconds. Premature at v0."
rules_consulted:
  - rule_01KR441EAF7M5QPF65BXGD1ET1
decided_by: torrenegra
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-049 — v0 scale target = Tier B (1k-100k entities)

Resolves [open question #13](../DECISIONS.md). Sets the design budget for the
index, runtime, and any analytics work. Centrality / PageRank compute is
in-process (igraph or NetworkX-equivalent) when added; no graph DB swap until
profiling at >100k entities shows recursive-CTE traversal as the bottleneck.

## Latency budgets at the Tier B upper bound

| Operation | Budget | How |
|---|---|---|
| Entity read by ID | sub-ms | SQLite primary-key lookup |
| One-hop edge query | <10 ms | edges adjacency, indexed |
| `find-rules` precise tier | <50 ms | scope_match denormalization (D-026) |
| `find-rules` semantic tier | <500 ms | sqlite-vec NN search |
| Full `doco lint` pass | <5 s | every invariant Rule × every entity |
| PageRank refresh (when added) | <30 s | offline; written into centrality_scores table |
