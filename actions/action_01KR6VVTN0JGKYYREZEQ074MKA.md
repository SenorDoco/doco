---
id: action_01KR6VVTN0JGKYYREZEQ074MKA
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: move the per-Doco menu (Recent / Intents / Ideas / Rules / Decisions / Actions / Search / Lint) out of the app bar into its own row or a sidebar. Today the breadcrumb and nav share one cramped row."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: move_menu_outside_app_bar

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Add to backlog: move the menu to be outside of the app bar."
  context: |
    Today's per-Doco entity-list nav is in the same row as the
    breadcrumb (e.g. `/ Test Host / alice / test-9b`). On the screenshot
    the nav reads: Recent, Intents, Ideas, Rules, Decisions, Actions,
    Search, Lint. Crammed alongside the brand mark and the breadcrumb
    on one line.

outputs:
  expected:
    options:
      - "Sub-bar approach: keep the app bar with brand + breadcrumb + sign-in; render the nav as a second row beneath it. Simple flex/grid change in `packages/web/app/components/site-header.tsx`."
      - "Sidebar approach: move the nav into a left rail. Bigger UX change; hot for desktop, awkward on mobile."
      - "Hybrid: sub-bar on narrow viewports, sidebar on wide. Most polished but most code."
    files_to_change:
      - "packages/web/app/components/site-header.tsx (split row OR move to a sidebar component)"
      - "Possibly app/root.tsx if the layout structure changes (sidebar needs main-content sibling)."
    decision_to_make:
      - "Sub-bar vs sidebar — depends on how many sections the Doco eventually has. Today 8 nav items fit in one row at desktop width; a Doco with 12+ sections would benefit from a sidebar."
      - "If sub-bar: should the breadcrumb move to the sub-bar instead of the nav?"

created_at: 2026-05-09T17:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: proposed
status: planned
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — Menu outside the app bar

The per-Doco nav (Recent / Intents / Ideas / Rules / Decisions /
Actions / Search / Lint) currently shares its row with the brand
mark and the breadcrumb. Visually crowded; on smaller viewports the
nav truncates.

When picked up: pick sub-bar (fastest, ~30 lines in site-header.tsx)
or sidebar (better long-term, but a layout shift). No urgency until
the Doco has more sections than fit comfortably.
