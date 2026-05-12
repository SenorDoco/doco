---
id: decision_01KREMDWG8FMBDEHP245T5D6WA
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Recent feed renders newest at the bottom (chronological append), polls every 5 seconds for new items, and surfaces off-screen new items via a sticky 'N new ↓' badge. Polling, not SSE; cheap and good enough."

slug: live-recent-feed-polling
number: "ADR-089"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "The Recent feed is the home page (D-045). It rendered DESC by created_at — newest at the top, static, refresh-on-reload. Founder wants it to render live, append new items at the bottom (chronological), and surface new items off-screen. How is it built?"
chosen: |
  **Polling.** A `<RecentFeed>` client component renders the
  server-side-loaded initial list (ASC by created_at, oldest first,
  newest last) and polls `GET /api/recent?since=<latest-created_at>`
  every 5 seconds. New items are appended to the bottom. An
  `IntersectionObserver` on a sentinel at the list's bottom tells us
  whether the user is scrolled at the latest item; when they're
  scrolled up and new items have arrived, a sticky `"N new ↓"` badge
  surfaces them and scrolls into view on click.

  ### Why polling, not SSE / WebSockets

  - **Cheap.** No long-lived connection management. Each request is
    a regular HTTP GET that opens, reads from `.doco/cache.db`, closes.
  - **Forgiving cadence.** Per-Doco activity arrives slowly enough
    that 5-second polling is invisible.
  - **No new infra.** Reuses the existing Remix resource-route pattern.

  The trade-off is up-to-5-seconds-of-latency on new items; an
  acceptable price.

  ### The indexer trigger question (deferred)

  Polling against the cache means new items only surface after
  `doco reindex` writes to `.doco/cache.db`. A filesystem watcher
  that auto-reindexes on entity-file change would tighten the loop;
  not built yet. Captured as a follow-up via the polling endpoint —
  the same endpoint serves once auto-reindex lands.

alternatives:
  - name: Server-Sent Events (SSE)
    rejected_because: "Requires the indexer to emit notifications when entities are written. Today reindex runs on demand (CLI or post-create). Building the SSE side without solving the indexer-trigger side is a longer build for the same end-user latency."
  - name: WebSockets
    rejected_because: "Heavier than SSE for a one-way feed. Same indexer-trigger problem as SSE."
  - name: useRevalidator (Remix periodic re-fetch of the loader)
    rejected_because: "Re-runs the entire loader every tick, including any other data the page might load. Resource-route GET /api/recent?since= is narrower and won't pull unrelated data."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-12T11:00:00Z

created_at: 2026-05-12T11:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-089 — Live Recent feed (polling + chronological append)

Implementation:
- [packages/web/app/components/recent-feed.tsx](../packages/web/app/components/recent-feed.tsx) — client component, polling + `IntersectionObserver` for the off-screen badge.
- [packages/web/app/routes/api.recent.tsx](../packages/web/app/routes/api.recent.tsx) — resource route returning items with `created_at > since`, ASC.
- [packages/web/app/routes/_index.tsx](../packages/web/app/routes/_index.tsx) — loader provides the SSR'd initial list; the component takes over for live updates.

## Follow-up: filesystem watcher

A `doco watch` mode (or a long-running flag on `doco serve`) could
detect entity-file changes and trigger incremental reindex. Until
then, agents writing new entities should run `doco reindex` for the
new item to surface in the Recent feed within the next 5-second poll.
