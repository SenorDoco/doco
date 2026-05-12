---
id: decision_01KR6V6W4HMM5CBJV22FD0HFSP
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Graph-quality strategy: connectivity lint + 'Referenced by' UI + suggest API. Three layers prevent isolated nodes — at validate-time, at view-time, and at write-time."

slug: graph-quality-strategy
number: "ADR-075"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "As a Doco grows, nodes that aren't well-connected to their context get missed by searches and ripple-effect updates. The orphan-reasoning lint covers one type. What's the strategy for keeping every node in its proper graph neighborhood?"
chosen: |
  Three layers, each at a different moment in the entity's life:

  ### A. Connectivity lint (validate-time)

  `lintConnectivity` extends the orphan pattern across content types.
  Fires warnings, not errors:

  - **Decision** with no edge to (Intent | Rule | Decision)
  - **Action** with no edge to (Intent | Decision)
  - **Rule** with empty `applies_to.tags` AND empty `applies_to.types`
  - **Idea** with no tags
  - **Intent** with no tags

  Reads from the indexer's `edges` table; runs as part of
  `runAllLints`. Reasoning has its own dedicated lint
  (orphan-reasoning); not duplicated.

  **Severity is warning, not error.** The first run in this Doco
  flagged 8 Rules with empty `applies_to` — a real signal that earned
  a backfill, but not a release blocker. Tighten to error after the
  meta-Doco's own state is clean.

  ### C. "Referenced by" view-time UI

  Every entity-detail page (single-Doco and host modes) renders a
  "Referenced by (N)" card. Always visible — even when N=0. A zero
  count is a deliberate visual cue that the entity is a leaf, asking
  the author to either confirm that's right or wire it into context.

  Reads from `edges` where `to_id = entity.id`. Group by `from_node_type`
  for readability.

  ### D. Suggest API (write-time)

  `POST /api/v1/suggest` runs FTS5 over `summary + body` of every
  entity and returns top-K matches by bm25. Designed for the moment
  before an agent writes a new entity:

  ```
  POST /api/v1/suggest
  { "summary": "<draft>", "body": "<optional>", "type": "<optional>", "limit": 10 }
  → { "matches": [{ id, node_type, summary, score }, ...] }
  ```

  AGENT.md gains a step: "Before you write a new entity, call this and
  link any relevant matches in the appropriate refs field." The
  connectivity lint catches the case where the agent skips this step.

  ## What's deferred

  - **Embeddings-based suggest**. FTS5 is a strong MVP but misses
    semantic similarity (different vocabulary for the same concept).
    Embeddings would close that gap — already foreseen via
    `OPENAI_API_KEY`. Real corpus first, then embeddings.
  - **Tag hierarchy** (option B from the brainstorm). Mandatory scope
    tags need a Decision on which tags exist and whether they're
    nested. Pragmatic step: introduce it after the lint surfaces
    enough orphans to justify the investment.
  - **Graph-level audit command** (option E). Useful when the lint
    starts catching the easy cases and only harder graph-shape
    problems remain. Today the lint is sufficient.
alternatives:
  - name: A only (just expand the lint)
    rejected_because: "Catches problems but doesn't help authors fix them. Suggest API is what makes the linting actionable."
  - name: D only (suggest API, no lint)
    rejected_because: "An agent can ignore the suggest endpoint. The lint is the backstop that catches what suggest didn't catch."
  - name: Embeddings now instead of FTS
    rejected_because: "Adds a network dependency for every authoring action. FTS is cheap, deterministic, and offline. Embeddings layer in once the lexical-only signal stops being enough."
rules_consulted:
  - rule_01KR441EAGVR2GFZAP9BMTSBG8   # orphan-reasoning rule (the existing pattern this generalizes)
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-09T17:10:00Z

created_at: 2026-05-09T17:10:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-075 — Graph-quality strategy

## Why three layers

Graph isolation is a slow-acting failure mode. A node misconnects at
write-time, then survives unnoticed because:

- It's hard to *see* (no incoming edges → never surfaced as "related")
- It's hard to *find* in graph queries (only text search hits it)
- It's hard to *update* when the topic moves (the propagator follows
  edges, not text)

Each layer addresses a different failure mode:

- **A (lint)** stops the entity from being written without context in
  the first place.
- **C (UI)** lets a human notice isolation by glance, not by scanning.
- **D (suggest)** lowers the cost of doing the right thing at
  write-time — agents don't have to scan the corpus by hand.

## Severity ladder

The connectivity lint starts at warning. Once the meta-Doco's own
state is clean (the 8 flagged Rules backfilled with proper
`applies_to`), graduate to error. That earns the right to fail
validation when an entity is being written without context — not before.

## Why FTS first, embeddings later

FTS5 is built into SQLite, runs offline, takes no API budget, and ships
with the indexer we already have. Embeddings would handle semantic
overlap (e.g., "agent credentials" matches "auth tokens"), but that
gain only matters once the corpus is large enough that the lexical
signal saturates. Today's 122-entity Doco doesn't need embeddings.
The system is designed to layer them in via `OPENAI_API_KEY`
when the time comes.

## Connection to AGENT.md §4

Section 4 of AGENT.md ("Attribute your work") now includes a step
before writing: query `/api/v1/suggest`, read the matches, link any
that are relevant. The lint is the backstop if the agent skips this
step; the UI's "Referenced by" surface is the long-term observatory.

## What this Decision doesn't cover

- The tag hierarchy (option B from the brainstorm). Worth a separate
  Decision once the lint has been running long enough to show which
  tags would actually carry their weight.
- A graph-level audit command (option E). Useful when isolated nodes
  cluster into disconnected components — for now the per-entity lint
  catches them one at a time.
