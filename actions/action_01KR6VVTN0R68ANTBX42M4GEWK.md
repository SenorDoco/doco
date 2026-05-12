---
id: action_01KR6VVTN0R68ANTBX42M4GEWK
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: Recent feed renders in real time with new items appended at the bottom. UX hints when new items appear off-screen — both below the current scroll and in the unrendered tail."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: realtime_recent_feed

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Add to Backlog: Recent should render in real time. New items at
    the bottom. If the user scrolled up and there are items at the
    bottom, make it obvious with the UX. If new items show up outside
    of the view, also make it obvious."

outputs:
  expected:
    behavior:
      - "Recent feed is the home page in single-Doco mode (and in per-Doco mode under host)."
      - "Today: server-rendered list of last 30 entities, ordered DESC by created_at. Static — refreshes only on page reload."
      - "Wanted: list updates live as new entities appear in the indexer (or directly in the source files)."
      - "New items append at the BOTTOM (chronological, oldest at top, newest at bottom). Today the order is reversed (DESC) — needs flipping."
      - "If the user has scrolled up and new items are below the viewport, surface a 'New items below' affordance (sticky badge, scroll-to-bottom button)."
      - "If new items appear above the viewport (they shouldn't if we always append at the bottom — but the same UX applies if the user is scrolled mid-list), same affordance pointing the right way."
    implementation_options:
      - "Polling: client polls /api/v1/recent every N seconds. Cheap, no infra; latency ≤ N."
      - "SSE / Server-Sent Events: server pushes new entities as they're indexed. Real real-time. Needs the indexer to emit a notification."
      - "WebSockets: heavier than SSE for a one-way feed; SSE is simpler."
    files_likely_to_change:
      - "packages/web/app/routes/_index.tsx (single-Doco) and equivalent host-mode route"
      - "packages/api/src/server.ts — new GET /api/v1/recent (polling) or /api/v1/recent/stream (SSE)"
      - "packages/index/src/insert.ts or build.ts — emit a notification when entities are inserted (for SSE)"
      - "New React hook for the live feed; intersection-observer or scroll-position tracking for the 'new items below' affordance"

  considerations:
    - "Order flip: today entities sort DESC by created_at (newest first). Real-time append-at-bottom flips that. Existing screenshots/UX assume newest-first; the rewrite must update both views consistently."
    - "Indexer trigger: today reindex runs on demand (CLI or the post-create call in agents.new and onboarding.create.agent). Real-time feed needs reindex to happen when an agent writes a new file — file-system watcher or an API endpoint that does it."
    - "Multi-instance reality: in host mode, each Doco has its own .doco/cache.db and its own feed. Real-time scopes per-Doco."

created_at: 2026-05-09T17:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: proposed
status: planned
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — Real-time Recent

Today's Recent feed is server-rendered, ordered newest-first, and
refreshes only on page reload. The user wants it to feel alive: new
entities stream in, appended at the bottom, with explicit UX cues
when fresh content lands outside the current viewport.

Real-time = polling or SSE. Polling is cheap to ship; SSE is the right
shape for a one-way feed. Either way, the *order* flips — today's
DESC-by-created_at becomes ASC-by-created_at, with the freshest item
at the bottom of the visible list.

The two off-screen affordances:

1. **New items below the viewport.** When the user has scrolled up and
   N new items have arrived since their scroll position, show a sticky
   badge: *"3 new entities below — jump to bottom"*. Click → scroll
   to end.
2. **New items appearing while the viewport is at the bottom.** Auto-
   scroll if the user is already at the bottom; otherwise the badge
   from (1) covers it.

Picking this up needs:
- A reindex trigger that fires when entity files change (file watcher
  or hook into the create endpoints). Today reindex is on-demand.
- A new endpoint: GET /api/v1/recent (polling) and/or
  GET /api/v1/recent/stream (SSE). Returns the same data the home
  page renders today, just live.
- Client-side scroll tracking + the badge UI.

Estimated effort: a focused day or two. Not blocking; pick up when
the static feed feels stale.
