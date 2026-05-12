---
id: decision_01KR8Y6VSS2TBQFQ2AQCXB81TK
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Scope hierarchy moves from slash-in-name to parent-edges. Names are flat tokens; the existing `Scope.scopes` field carries parent ids. Slash-input on /scopes/new is a UX convenience that auto-creates parents."

slug: edge-hierarchical-scopes
number: "ADR-081"
follows:
  - decision_01KR76H4DAJ1ZR26ZTD69CQD8H   # ADR-079 (scope-driven discoverability — picked slash-in-name)
  - decision_01KR74PX31DH2Q70B6JFV8PQ14   # ADR-078 (tag → scope rename)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "ADR-079 picked slash-in-name (`country/france/payment` is one Scope). Stringly-typed: renaming the parent silently orphans children. Single-parent: a scope can only sit under one tree. Inconsistent: every other relationship in Doco is an edge, only scopes encode structure in a string. Can we do better without a heavy schema change?"
chosen: |
  Edge-hierarchical scopes. The existing `Scope.scopes: []` common field
  becomes the parent-edges field for scope-to-scope relationships.
  `country/france/payment` is now three Scope entities — `country`,
  `france` (with `scopes: [country.id]`), `payment` (with
  `scopes: [france.id]`).

  ### Schema

  - `Scope.name` regex tightens: `^[a-z][a-z0-9_-]*$` (no slashes).
  - `Scope.scopes: [scope_id, ...]` stays optional; semantics shift from
    "what this scope categorically belongs to" to "the scope's parents in
    the hierarchy." (Multi-parent supported — a `payment` scope can sit
    under both `country/france` and `concern/finance`.)

  No new field, no migration friction beyond renaming.

  ### Indexer

  No change. The generic `FIELD_TO_EDGE_TYPE` already maps `scopes` →
  `in_scope_of`. So a scope with `scopes: [parent_id]` produces an edge
  with `from_node_type=scope, to_node_type=scope, edge_type=in_scope_of`.
  Sub-scope queries become:
  ```sql
  SELECT s.id, s.name FROM scope s
  JOIN edges e ON e.from_id = s.id
              AND e.edge_type = 'in_scope_of'
              AND e.from_node_type = 'scope'
              AND e.to_id = ?
  ```
  No new edge type, no new table, no new columns.

  ### UX: slash-input still works

  Users type `country/france/payment` on `/scopes/new`; the action handler
  parses each line into segments, ensures a Scope per segment exists
  (reuse by name; create if missing), and sets parent edges. Friendly
  input, edge-clean storage.

  Helpers:
  - `parseScopeNamesInput(text) → { valid: string[][], invalid: string[] }`
    splits on slashes; each `valid` entry is a path of segments.
  - `materializeScopeTree({ paths, existingByName, ... })` walks each
    path root → leaf, ensuring each segment exists and is parented.
  - `migrateScopesInDoco({ docoDir, ... })` one-shot helper for
    converting existing slash-named scopes — splits names, ensures each
    segment, renames the leaf scope, sets parent edges. Idempotent.

  ### Bootstrap response

  `GET /api/v1/agent-bootstrap` per-scope payload now includes:
  ```jsonc
  {
    "id", "name", "summary",
    "purpose", "guidelines",   // ADR-082
    "parent_ids": ["scope_..."],
    "member_count": <content-nodes-only>,
    "sub_scope_count": <child-scopes>
  }
  ```
  Agents reconstruct the tree client-side from `parent_ids`. `member_count`
  excludes scope-to-scope edges so a parent scope's count doesn't include
  its children's "I'm in this scope" claim.

  ### Member-count semantics

  `in_scope_of` is now used for two relationships: content-node → scope
  (membership) and scope → scope (parent). The bootstrap query separates
  them by filtering `from_node_type != 'scope'` for member_count and
  `from_node_type = 'scope'` for sub_scope_count. The connectivity lint
  also filters by from_node_type when checking content-node membership.

  ### Migration ran cleanly

  `migrateScopesInDoco` against the test docos:
  - `alice/test10a`: 3 renamed (scope1/scope11 → scope11, scope1/scope111
    → scope111, scope4/scope41 → scope41), 1 created (scope4 — scope1
    already existed flat).
  - `host-bootstrap/phase18-rev2-test`: 4 renamed, 5 created.

  Existing scope ids stay stable; only `name` and `scopes` change. Every
  member's `scopes: [<old_leaf_id>]` reference still resolves.

alternatives:
  - name: Add `parent_scope_id` (single-parent) field
    rejected_because: "Single-parent. A scope like `payment` belongs naturally to both `country/france` and `concern/finance`. The existing `scopes` field handles this without a new column."
  - name: Add a dedicated `parent_scope` edge type (separate from `in_scope_of`)
    rejected_because: "More complexity, more lint code-paths. The semantics — child scope is in scope of its parent — are honest with `in_scope_of`. Queries filter by `from_node_type='scope'` when they want the scope-vs-content distinction."
  - name: Keep slash-in-name but ALSO write parent edges (dual encoding)
    rejected_because: "Worst of both worlds: name still looks like a path; query layer has to keep agreeing with the name parser. Pick one truth."
  - name: Defer migration; make schema accept both for a transitional release
    rejected_because: "Hard cutover requested by the user. Migration is trivial (handful of slash-named scopes); soft transition just means the same code in twice for longer."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-10T05:30:00Z

created_at: 2026-05-10T05:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-081 — Edge-hierarchical scopes

## Why

ADR-079 picked slash-in-name for scope hierarchy. Three months in, the
limitations show:

- **Stringly-typed.** `country/france/payment` is one Scope; renaming
  `france` silently orphans `country/france/payment` and any child below.
- **Single-parent.** A scope can only sit under one path. `payment` can't
  belong to both `country/france` and `concern/finance`.
- **Inconsistent.** Every other relationship in Doco is an edge. Scopes
  alone encode structure in a string.

The existing `Scope.scopes: []` common field already supports the better
version — we just weren't using it.

## What ships

| change | where |
|---|---|
| `Scope.name` regex tightens to `^[a-z][a-z0-9_-]*$` | `schema/doco.schema.json` |
| `Scope.scopes: []` semantics = parent edges | (no schema change — same field, new semantics) |
| `parseScopeNamesInput` returns `string[][]` (segments per line) | `packages/host/src/host.ts` |
| `materializeScopeTree({ paths, existingByName, templateForLeaf })` | `packages/host/src/host.ts` |
| `migrateScopesInDoco({ docoDir, ... })` — one-shot conversion | `packages/host/src/host.ts` |
| Bootstrap returns `parent_ids`, `member_count` (content-only), `sub_scope_count` | `packages/api/src/server.ts` |
| Scope detail page derives sub-scopes from edges, not slash matching | `packages/web/app/routes/e.$type.$id.tsx` |
| `/scopes/new` slash-input → segments → tree | `packages/web/app/routes/$ownerSlug.$docoSlug.scopes.new.tsx` |

## Migration

`migrateScopesInDoco` ran on the test docos: idempotent, preserves ids,
splits slash-names into per-segment scopes with parent edges.

## What's deferred

- Cycle detection on parent edges. Today nothing prevents a scope from
  being its own ancestor. Add a lint when usage shows a way to write that
  by accident; small surface area today.
- Multi-parent UX in `/scopes/new`. Slash-input only expresses
  single-parent paths. Adding `;` or `,` for multi-parent input is
  straightforward but premature.
