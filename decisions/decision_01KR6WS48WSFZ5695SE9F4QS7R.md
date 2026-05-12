---
id: decision_01KR6WS48WSFZ5695SE9F4QS7R
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Entity-detail page is split: left = details (existing content), right = force-directed graph map. Personalized PageRank picks the most relevant neighborhood. Mobile collapses the split into tabs."

slug: entity-detail-graph-map
number: "ADR-076"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Detail pages are textual; readers can't see the entity's neighborhood at a glance. ADR-075 (graph quality) makes connectivity matter; this Decision asks: how should the page surface that connectivity visually?"
chosen: |
  Two pieces:

  ### Layout

  - **Desktop (md+)**: 2-column grid. Left = existing details (header,
    edges tables, raw entity). Right = the map.
  - **Mobile (<md)**: Tabs — Details / Map — both panes available, one
    visible at a time.

  Driven by Tailwind responsive classes; the React component carries a
  `useState<'details'|'map'>` for the mobile-only tab choice.

  ### Map

  - **Force-directed graph** rendered with `react-force-graph-2d`
    (canvas, ~1MB lib).
  - **Center node**: the focal entity, sized 3× larger than peers, pinned
    at the layout origin.
  - **Neighbors**: top-K (K=25 default) most relevant other nodes,
    selected by Personalized PageRank.
  - **Edges**: only edges between included nodes (no phantom half-edges
    to nodes outside the visible set).
  - **Color**: per node_type, fixed palette. Each type gets a distinct
    hue against the light theme.
  - **Filter**: checkboxes at the top, one per type present in the
    current graph; unchecking hides nodes of that type (the focal node
    stays regardless).
  - **Interactions**: drag (pan), scroll (zoom), click any node →
    navigate to that entity's page.
  - **Hover**: tooltip with the node's `node_type: summary`.

  ### Personalized PageRank

  - Standard PPR with damping α=0.85, max 50 iterations, convergence
    tolerance 1e-6.
  - Edges treated as **undirected** for relevance — for context
    discovery, "A serves Intent I" and "I has Action A" are equally
    informative.
  - Personalization vector concentrated on the focal node (1 at source,
    0 elsewhere).
  - Dangling-mass redistribution lands on the personalization vector —
    keeps mass at 1 and favors the source's neighborhood.
  - Top-K result excludes the source itself.

  ### Why client-side rendering

  `react-force-graph-2d` uses canvas + `window`, so it can't run during
  SSR. Component dynamic-imports the lib in a `useEffect` and shows a
  "Loading graph…" placeholder until it lands. Server still computes
  PPR + builds the node/link arrays in the loader.
alternatives:
  - name: D3-force + custom SVG
    rejected_because: "~80KB vs ~1MB but every bit of pan/zoom/drag has to be wired by hand. Lib pays for itself the first time we want to add an interaction."
  - name: "@xyflow/react (formerly react-flow)"
    rejected_because: "More flowchart-shaped — needs a layout engine plug-in for force-directed feel. react-force-graph-2d is purpose-built for this exact shape."
  - name: Cytoscape.js
    rejected_because: "Heavier (~1.5MB), broader API. Overkill for a single graph view."
  - name: Plain text 'related' list (no graph)
    rejected_because: "Doesn't give the visual gestalt the user asked for. Connectivity is spatial; render it spatially."
  - name: Standard PageRank instead of personalized
    rejected_because: "Returns globally important nodes regardless of focus. PPR returns relevant-to-this-node, which is what the page asks. Trivial to compute, big quality difference."
  - name: Adjacency-only (1-hop) instead of PPR
    rejected_because: "Too local — nodes 2 hops away that strongly cluster with the focal node would never appear. PPR captures multi-hop relevance with a closed-form decay."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: torrenegra
decided_at: 2026-05-09T18:00:00Z

created_at: 2026-05-09T18:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-076 — Entity-detail graph map

## Why a map at all

ADR-075 established that connectivity matters: isolated nodes get lost
in graph queries and updates. The connectivity lint enforces a
minimum; this Decision goes the other direction — it makes the
existing connectivity *visible*, so readers see at a glance how an
entity sits in its neighborhood.

The map is the spatial representation of what the existing "Edges
(outgoing)" and "Referenced by" tables already capture. The tables
list edges; the map renders them. Both are kept — they're different
affordances for the same data.

## PPR vs alternatives

The first impulse is "show me the directly-connected nodes" (1-hop
neighbors). For a sparse graph that's fine; for a 130+ entity Doco
where nodes commonly have 5–10 direct edges and clusters reach 2–3
hops, 1-hop misses real context.

PPR weights nodes by random-walk-with-restart from the focal node:
high score = the random walker visits this node often when re-
anchored at the source. The result is a continuous notion of
relevance, decaying with distance but recognizing tight clusters.

α=0.85 is the standard PageRank damping. Higher α → more far-reaching
relevance; lower α → more local. 0.85 is a good default; tunable per
visualization if needed later.

## Type colors

Fixed palette in `entity-graph.tsx`. Picked for distinctness against
each other and visibility on the light Tailwind theme:

| Type | Hex | Why |
|---|---|---|
| doco | `#525252` | gray (structural, neutral) |
| principal | `#3b82f6` | blue (people) |
| organization | `#6366f1` | indigo (people-collective) |
| intent | `#16a34a` | green (forward-looking, growth) |
| idea | `#ec4899` | pink (speculative, fresh) |
| rule | `#dc2626` | red (constraint) |
| decision | `#f97316` | orange (deliberate) |
| action | `#9333ea` | purple (action, motion) |
| reasoning | `#eab308` | yellow (cognition) |
| evaluation | `#14b8a6` | teal (judgment) |
| reference | `#a16207` | brown (external) |
| tag | `#84cc16` | lime (cross-cutting) |

## Performance

PPR on the meta-Doco's ~130 nodes converges in 5–10 iterations,
under 10ms server-side. For a 10k-node Doco, expect 50ms–200ms
depending on edge density. If it ever becomes a bottleneck, cache
PPR results per-source in the indexer and invalidate on edge changes.

## Mobile collapsing

Below the `md` breakpoint (768px), the 2-column grid collapses to a
single column. Showing both panes stacked would force the user to
scroll past the entire details list to reach the map. Tabs let
either be one tap away. Both panes are mounted; the inactive one is
just `display: none`.

## What's deferred

- Edge-type labels on links — clutter at this scale; revisit if a
  user-test shows confusion.
- Edge color by edge_type — same; for now all edges are the brand
  olive at 40% opacity.
- "Pin focal node at center" — react-force-graph's force simulation
  drifts the focal node based on its mass. Today we set its
  `nodeVal` higher (visual weight) but don't pin it. If it drifts off-
  screen, add `fx`/`fy` constraints.
- Cross-Doco map (host-mode aggregate) — the per-Doco map is what
  most readers want. A host-level map across all Docos is a separate
  feature.
