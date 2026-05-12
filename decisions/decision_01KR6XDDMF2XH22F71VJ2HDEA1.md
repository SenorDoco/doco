---
id: decision_01KR6XDDMF2XH22F71VJ2HDEA1
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Add `follows: [<entity_id>]` to common_fields. BPMN-style ordering / dependency edge available on every entity. Lint forbids cycles."

slug: follows-field-bpmn-ordering
number: "ADR-077"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
follows:
  - decision_01KR6V6W4HMM5CBJV22FD0HFSP   # ADR-075 (graph quality — connectivity lint pattern this extends)
  - decision_01KR6WS48WSFZ5695SE9F4QS7R   # ADR-076 (graph map — the consumer that benefits from explicit ordering edges)
question: "BPMN-style documentation describes processes as sequenced steps. Today's schema captures dependency only when a node-type-specific field exists (e.g. Decision.intent_ids). For generic ordering — 'this Action comes after that one' — there's no shared field. What's the minimum addition that handles it?"
chosen: |
  Add `follows: [<entity_id>]` to `common_fields`. Optional, defaults
  to empty array. Available on every node type.

  Per the fields-as-edges convention, the indexer derives a `follows`
  edge from each id in the array. The new edge type joins the
  enumerated list (serves, enacts, consults, ..., follows).

  ### Lint

  `lintFollowsCycle` — DFS from every node tracking the recursion
  stack; report a cycle if we re-visit a node still on the stack.
  Severity: error (cycles in `follows` are meaningless and break
  topological traversal). Reports each cycle once via canonical-
  rotation deduping.

  ### Why generic, not per-type

  Sequencing applies to many node types: Actions in a workflow,
  Decisions in a deliberation chain, Intents that depend on prior
  Intents, Ideas that follow earlier Ideas. A per-type field would
  multiply by every type that wanted it. A common field captures all
  of them with one entry.

  ### Why undirected in the graph view, directed for the lint

  The graph map (ADR-076) treats edges as undirected for relevance
  computation — context flows both ways. The cycle lint operates on
  the directed `follows` semantics specifically, because "A follows B
  follows A" is a real contradiction that an undirected view would
  hide.

  ### Diagram + table updates

  - SCHEMA.md §6 ASCII diagram: added `* --follows--> *` with the note
    "ordering / dependency; lint forbids cycles (ADR-077)".
  - SCHEMA.md §6.1 fields-as-edges table: added `*.follows[] →
    Follows`.
  - `packages/index/src/migrate.ts`: extended the `edges.edge_type`
    comment to enumerate `follows`.
  - `packages/index/src/edges.ts`: `FIELD_TO_EDGE_TYPE.follows =
    "follows"` (canonical, in case future renames change the
    convention).

alternatives:
  - name: A per-type `prev_action_id` field
    rejected_because: "Multiplies. Every node type would need its own. Common field handles all of them."
  - name: An edge-only convention with no field
    rejected_because: "Edges are derived from fields. No field, no derivation. The whole point of fields-as-edges (ADR-D-017) is that frontmatter is the source of truth."
  - name: Allow cycles as a warning instead of an error
    rejected_because: "A cycle in `follows` makes ordering undefined. There's no useful semantic. Error is correct."

rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-09T18:30:00Z

created_at: 2026-05-09T18:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-077 — `follows` field for BPMN ordering

## Why now

Up to ADR-076, the schema captured ordering only via type-specific
fields (Decision.intent_ids, Action.decision_ids). For BPMN-shaped
work — "Action B comes after Action A which came after Action 0" —
there was no place to record the ordering generically.

This Decision adds `follows: [<entity_id>]` to common_fields. Any
entity can declare what it comes after. The indexer materializes
the edge automatically (fields-as-edges); the cycle lint catches
the obvious failure mode.

## Where it surfaces

- **Schema** (`schema/doco.schema.json`): added to `common_fields`
  as an optional array of ids.
- **TS types** (`packages/shared/src/entities.ts`): added to
  `CommonFields`.
- **Indexer** (`packages/index/src/edges.ts`): `follows` field maps
  to `follows` edge type via `FIELD_TO_EDGE_TYPE`.
- **Edges-table comment** (`packages/index/src/migrate.ts`):
  enumerates `follows` alongside the other edge types.
- **SCHEMA.md** §6 (relationships diagram) + §6.1 (fields-as-edges
  table): added the new edge.
- **Lint** (`packages/lints/src/follows-cycle.ts`): DFS-based cycle
  detection. Tested with synthetic graphs covering acyclic chains,
  self-loops, 2-node cycles, 3-node cycles, and mixed disjoint
  components.

## Self-application

This Decision uses `follows` for itself: it points at ADR-075
(connectivity lint, which `follows-cycle` is a sibling of) and
ADR-076 (graph map, which gets richer when ordering edges exist).
The companion Action follows this Decision plus the prior phase
Actions in chronological / dependency order — making this Doco the
first to use the field it just added.

## Future work

- Topological-sort views: a "process flow" view that lays out
  follows-connected entities as a DAG (left → right) instead of the
  force-directed cluster of ADR-076. Useful when the graph IS a
  process. Deferred until a real process is documented in this Doco.
- Branch / parallel paths: BPMN's full vocabulary includes XOR
  gateways, parallel splits, etc. `follows` is a single linear
  predecessor list. Richer relationships (gateway nodes) would be a
  separate Decision; not needed yet.
