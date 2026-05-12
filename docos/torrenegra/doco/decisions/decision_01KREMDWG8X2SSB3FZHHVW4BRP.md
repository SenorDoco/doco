---
id: decision_01KREMDWG8X2SSB3FZHHVW4BRP
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Per-Doco navigation moves out of the app bar into a second row beneath the brand+breadcrumb. The previous one-row layout grew cramped as nav items accumulated; a sub-bar gives the nav room and keeps the brand line scannable."

slug: per-doco-nav-as-sub-bar
number: "ADR-088"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "The site header packed brand mark + breadcrumb + nav (Recent / Scopes / Intents / Ideas / Rules / Decisions / Actions / Search / Lint) into one row. As the nav list grew, the row got cramped. Where should the per-Doco nav live?"
chosen: |
  **Two-row header.** Row 1 holds the brand mark + breadcrumb (and
  any future workspace-level actions). Row 2 holds the per-Doco
  navigation strip, separated by a hairline border.

  This is the sub-bar option from action_01KR6VVTN0JGKYYREZEQ074MKA.
  Sidebar was the alternative; deferred because (a) most viewports
  have horizontal real estate and (b) introducing a sidebar layout
  is bigger code churn than a row split. If the nav grows past
  ~12 items the sidebar option reopens.
alternatives:
  - name: Keep one row, just tighten spacing
    rejected_because: "Already at minimum comfortable gap. Tighter and link targets get hard to hit on touch. Crowding gets worse with each new nav item."
  - name: Left sidebar (always-on)
    rejected_because: "Bigger layout churn (need a main-content sibling). Awkward on mobile. Premature for a 9-item nav."
  - name: Hybrid (sidebar on wide, sub-bar on narrow)
    rejected_because: "Same churn as full sidebar plus complexity of two layouts. Earn the keep when the nav demands it."
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

# ADR-088 — Per-Doco navigation as a sub-bar

Implementation: [packages/web/app/components/site-header.tsx](../packages/web/app/components/site-header.tsx).
The first row carries brand + breadcrumb; the second row, separated by
`border-t border-border/60`, carries the per-Doco nav items.

When this might revisit: nav reaches ~12 items, or workspace-level
actions need room on the first row (e.g., a Doco switcher when local-solo
supports multiple Docos in a folder).
