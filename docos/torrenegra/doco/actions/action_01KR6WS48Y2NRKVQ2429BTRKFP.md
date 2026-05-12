---
id: action_01KR6WS48Y2NRKVQ2429BTRKFP
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 14 — entity-detail graph map. 2-column desktop / mobile-tabbed layout. Force-directed map of the focal node's PPR-ranked neighborhood with type-color filters, drag/zoom/pan, and click-to-navigate."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: ship_entity_detail_graph_map

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6WS48WSFZ5695SE9F4QS7R   # ADR-076

inputs:
  user_direction: |
    "Let's update the page where the details of a node are shown. It
    should be split in two:
    - Left section: what we see today
    - Right section: a map
    If shown on mobile screens or small screens instead, these two
    options should be tabbed. The map should show the graph where the
    node is in the center and the most relevant edges of that node
    should be shown around it. Users should be able to zoom in, zoom
    out, and drag and drop. Clicking on any node should take the
    person to that node page.
    What's relevant for a given null should be determined using a
    personal page rank algorithm.
    Different types of nodes should be rendered with different colors.
    On the top of the map, there should be a list of the node types
    that users can uncheck to simplify the rendering of the map."

outputs:
  source_files_changed:
    - packages/web/package.json                                            # added react-force-graph-2d ^1.29.1
    - packages/web/app/lib/pagerank.ts                                     # NEW — Personalized PageRank, undirected, top-K
    - packages/web/app/components/entity-graph.tsx                         # NEW — client-only force graph + type filters
    - packages/web/app/routes/e.$type.$id.tsx                              # 2-column / mobile-tab layout, PPR loader, map pane
    - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type.$id.tsx        # same for host-mode
    - decisions/decision_01KR6WS48WSFZ5695SE9F4QS7R.md                     # ADR-076
    - packages/index/src/__tests__/build.test.ts                           # bumped action count
    - packages/core/src/__tests__/loader.test.ts                           # bumped decision lower-bound
  features_shipped:
    layout:
      - "md+ breakpoint: side-by-side details + map (50/50 grid, 7xl max-width)"
      - "below md: tabs at the top, both panes mounted, inactive hidden"
    map:
      - "Force-directed canvas layout via react-force-graph-2d"
      - "Center node 3× larger than peers"
      - "Drag to pan, scroll to zoom, click to navigate (uses React Router useNavigate)"
      - "Hover tooltip: node_type + first 80 chars of summary"
    relevance:
      - "Personalized PageRank with α=0.85, max 50 iters, 1e-6 tolerance"
      - "Edges undirected for relevance computation (semantic context flows both ways)"
      - "Top 25 neighbors selected by PPR score; source node always included; only edges between included nodes rendered"
    types_and_filters:
      - "12-color palette per node_type: action=purple, decision=orange, intent=green, rule=red, idea=pink, principal=blue, etc."
      - "Type-filter checkboxes at top of map (one per type present in the graph)"
      - "Each checkbox has a colored dot matching its node fill"
      - "Unchecking a type hides those nodes (focal node always remains visible)"
  e2e_browser_verified:
    - "Single-Doco mode (this repo): /e/decision/<id> renders side-by-side. Map shows 26 nodes around the focal Decision (ADR-068 invitation flow). All 7 type filters visible with colored dots. Force layout settles into a tight cluster around the center."
    - "Click on a peer node navigates to /e/<type>/<id>"
    - "Drag/zoom/scroll all functional"

started_at: 2026-05-09T17:55:00Z
ended_at: 2026-05-09T18:05:00Z

created_at: 2026-05-09T18:05:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 14 — Entity-detail graph map

## What you see now

When you open any entity's detail page (e.g. an ADR), the page is
split:

- **Left** — the existing content (title card, outbound edges,
  Referenced-by, raw entity JSON) — unchanged.
- **Right** — a force-directed map showing the focal node and its
  top-25 most relevant neighbors. Type-filter checkboxes at the top.
- **Mobile** (<768px) — same content, but as Details / Map tabs.

The relevance ranking is Personalized PageRank from the focal node,
treating the indexer's edges as undirected. Top-K selection keeps the
view tractable.

## Implementation notes

### Library choice

`react-force-graph-2d` (canvas, ~1MB) over D3-force-with-custom-SVG
(~80KB). The lib pays for itself the first time anyone touches a
secondary interaction (drag pinning, double-click zoom, custom node
rendering). Bundle size is acceptable for a feature that only loads
on entity-detail pages.

### Client-only rendering

The lib uses `window` and canvas APIs — no SSR. Component dynamic-
imports it in `useEffect` and shows "Loading graph…" until it's
ready. The server still computes PPR + builds the node/link arrays
in the route loader; only the rendering is deferred.

### PPR details

`packages/web/app/lib/pagerank.ts` — pure TS. Builds an undirected
adjacency from the edges array, runs vector iterations until either
the rank delta drops below 1e-6 or the iteration cap (50). For 130
nodes converges in 5–10 iterations, well under 10ms.

### Type colors

Hard-coded palette in `entity-graph.tsx` — 12 colors, one per
node_type. Picked for mutual distinctness on the light theme. ADR-076
documents the table.

## What stays the same

- The existing "Edges (outgoing)" table on the left pane is unchanged.
- The "Referenced by" card from ADR-075 is unchanged.
- Entity slugs, IDs, and links all behave identically.

The map is purely additive — anyone who prefers the textual view
just stays on the left pane (or on mobile, leaves the Details tab
selected).
