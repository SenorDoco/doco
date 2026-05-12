---
id: decision_01KR8Z7YHJTEWP4QQZQ43MJMBQ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Scope management UX: tree view on /e/scope (parents at top, children indented), '+ New scope' button on the list, '+ Add child scope' link on each scope detail prefilling parent via ?parent=<id>."

slug: scope-management-ux
number: "ADR-084"
follows:
  - decision_01KR8Y6VSS2TBQFQ2AQCXB81TK   # ADR-081 (edge-hierarchical scopes)
  - decision_01KR8Y6VSVWHWB8MQNM5W9WJP2   # ADR-082 (scopes carry purpose + guidelines)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Now that scopes are hierarchical and self-explaining, the management UX is still a flat alphabetical list of names. Adding scopes requires navigating to /scopes/new manually; adding a child scope requires typing the parent name. The user said: make scope management easy. What's the minimum set of UX moves?"
chosen: |
  Three small moves on top of the existing /scopes/new flow. Together
  they make scope management low-friction without bloating the surface.

  ### 1. Tree view on `/e/scope`

  Replace the generic entity-table with a forest rendering: parents at
  depth 0, children indented (1.25 rem per level). Each row shows:

  - Scope name (link to detail)
  - Member count + sub-scope count: `(5 members · 2 children)`
  - Truncated purpose preview
  - `+ child` button (right-aligned) linking to
    `/scopes/new?parent=<id>`

  Tree built client-side from each scope's `parent_ids[0]` (multi-parent
  scopes appear under their first parent for tree-display; the detail
  page surfaces the full set of parents). Sorted alphabetically at each
  level.

  ### 2. `+ New scope` button on the list page

  Right-aligned in the card header. Direct link to
  `/${ownerSlug}/${docoSlug}/scopes/new`. Always visible regardless of
  scope count.

  Empty-state: "No scopes yet. Set up your first scopes →" links to
  `/scopes/new?onboarding=1` (showing the onboarding banner + Skip
  option).

  ### 3. `?parent=<id>` on `/scopes/new`

  When set, the page:

  - Shows a banner: "Adding child scopes under `<parent.name>`."
  - Custom-input scopes get the parent automatically prepended. Typing
    `payment` under `parent=country/france` (id) creates `payment` as
    a child of `france`. Slash-input still expresses *additional* depth
    — `regional/sepa` under that parent creates `regional` (child of
    `france`) → `sepa` (child of `regional`).
  - Templates ignore the parent (templates are top-level by
    definition).

  ### Two host-mode entity-detail pages

  Both `/e/scope/<id>` (single-Doco) and `/<owner>/<doco>/e/scope/<id>`
  (host-mode) gain the `+ Add child scope` link in the "Members of
  this scope" card header.

  ### Why minimum-viable

  Edit-in-place for purpose + guidelines was tempting, but it's a
  larger surface (form state, validation, save semantics, optimistic
  UI). Today the user can edit the YAML directly — scopes are tiny
  text files. Promote inline editing if the tree view shows enough
  daily use to justify it.

  Scope deletion likewise deferred. Today: delete the YAML file. With
  the connectivity lint catching orphans, this is safe enough.

alternatives:
  - name: Replace the entity-list page entirely with a separate /scopes route
    rejected_because: "More routes, more navigation. The /e/scope route is the canonical entity-list path; special-casing it for tree view inside the existing route keeps the URL space clean."
  - name: Build a full drag-and-drop tree editor for parent reorganization
    rejected_because: "Premature. The user asked for easy management, not for visual graph editing. Reparenting today = edit the child's `scopes:` field. Add drag-drop when reparenting becomes a daily task."
  - name: Inline-edit purpose + guidelines on the detail page
    rejected_because: "Worth doing, but expands this Phase's surface (form, save, optimistic UI). Captured for a follow-up Phase if usage shows demand."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-10T06:30:00Z

created_at: 2026-05-10T06:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-084 — Scope management UX

## Why

ADR-081 made scopes edge-hierarchical; ADR-082 gave them
purpose + guidelines. The list view (`/e/scope`) is still a flat
alphabetical table. Adding a child scope still means typing the
parent path manually.

User feedback: "make it easy to manage scopes."

## What ships

| change | where |
|---|---|
| Tree rendering on scope list (depth indent + member/sub counts + purpose preview) | `routes/$ownerSlug.$docoSlug.e.$type._index.tsx` (special-cased when `type === 'scope'`) |
| `+ New scope` button on list (always visible) | same |
| `+ Add child scope` link on each scope detail | `routes/$ownerSlug.$docoSlug.e.$type.$id.tsx` |
| `?parent=<id>` query param on `/scopes/new` (banner + auto-prefix custom paths) | `routes/$ownerSlug.$docoSlug.scopes.new.tsx` |

## What's deferred

- **Inline edit for purpose + guidelines.** Useful, but separate Phase.
- **Scope reparenting via drag-drop.** Premature; edit YAML for now.
- **Single-Doco mode `/e/scope` tree.** Same component lives there, but
  the meta-Doco's 6 scopes are all flat — tree view doesn't earn its
  keep yet. Apply when meta-Doco grows hierarchical scopes.
- **Scope delete UI.** Today: delete the YAML file + reindex.
