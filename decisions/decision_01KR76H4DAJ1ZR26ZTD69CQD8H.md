---
id: decision_01KR76H4DAJ1ZR26ZTD69CQD8H
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Scope-driven discoverability bundle: hierarchical names, multi-scope filter, scope landing pages, suggested_scopes API, tightened connectivity lint, scope-weighted PPR."

slug: scope-driven-discoverability
number: "ADR-079"
follows:
  - decision_01KR74PX31DH2Q70B6JFV8PQ14   # ADR-078 (tag → scope rename — this builds on it)
  - decision_01KR6V6W4HMM5CBJV22FD0HFSP   # ADR-075 (graph quality — connectivity lint extended)
  - decision_01KR6WS48WSFZ5695SE9F4QS7R   # ADR-076 (graph map — PPR weighting added)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "ADR-078 renamed tag → scope but didn't yet make scopes useful at scale. For very large Docos with many independent threads (user flows, country-specific payment policy, board-reported bugs), a single node should live in multiple useful 'neighborhoods' and be findable from any of them. What concrete moves enable this?"
chosen: |
  Six coordinated moves — none earns its keep alone; together they
  turn `scope` from a label into the navigation primitive of large
  Docos.

  ### 1. Hierarchical scope names (slash convention)

  Schema regex on `Scope.name`:
  - Before: `^[a-z][a-z0-9_]*$` — flat names only
  - After:  `^[a-z][a-z0-9_]*(/[a-z][a-z0-9_]*)*$` — slash-separated path

  Examples: `country/france/payment`, `user-flow/checkout`,
  `reporter/board`. Queryable with `name LIKE 'country/france/%'`
  for "everything under French".

  No new field; no migration; existing flat names stay valid. The
  hierarchy emerges as users start using slashes.

  ### 2. Multi-scope filter on entity-list pages

  `/e/<type>?scope=<id>&scope=<id>&scope_mode=all|any`

  - `?scope=` (repeatable) — set the filter
  - `?scope_mode=all` (default) — entity must be in ALL selected scopes
  - `?scope_mode=any` — entity in ANY of the selected scopes

  SQL: JOIN entity table to `edges` on `edge_type = 'in_scope_of'`,
  WHERE `to_id IN (...)`, GROUP BY entity, HAVING COUNT(*) = N for
  intersection. Renders chip-style toggleable scope filter at the
  top of the list. Each chip toggles its scope in the URL.

  ### 3. Scope landing pages

  When viewing `/e/scope/<id>`, the existing entity-detail layout
  gains a "Members of this scope" card that:
  - Lists members grouped by node type (intent, decision, action,
    rule, idea, reasoning) — top 25 per type
  - Shows each member's lifecycle as a badge
  - Links "See all <type>s in this scope →" to the filtered list
    from move #2
  - Surfaces sub-scopes (those whose name starts with this one + "/")

  The scope page becomes a per-topic dashboard instead of a flat
  "Referenced by" list.

  ### 4. `suggested_scopes` in `POST /api/v1/suggest`

  The endpoint already returns `matches: Entity[]`. Now also returns:

  ```json
  "suggested_scopes": [
    { "id": "scope_X", "name": "country/france/payment",
      "score": 2.28, "matched_in": 5 },
    ...
  ]
  ```

  Algorithm: aggregate scope memberships across the FTS-matched
  entities, weighted by inverse rank (1 / (i+1)). Top-N by aggregate
  score. Same endpoint, same call, two response sections.

  Lets agents auto-suggest scope assignments at write-time, the same
  way the suggest endpoint surfaces related entities.

  ### 5. Tightened connectivity lint

  Before: only Idea + Intent required ≥1 scope (warning).
  After: Decision and Action also require ≥1 scope (warning).

  Rule applies_to.tags renamed to applies_to.scopes per ADR-078.
  Same severity (warning) — the existing 8 bootstrap-Rule warnings
  stay; tightening to error happens after backfill.

  ### 6. Scope-weighted Personalized PageRank

  `personalizedPageRank` gains an `edgeWeight: (edge_type) => number`
  option. Default weight 1.0. The entity-detail map passes a
  function that returns 2.0 for `in_scope_of` and 1.0 otherwise.

  Effect: scope-shared neighbors rank closer to the focal node in
  the map. Cross-scope connections still surface but ranked below.
  Pulls topical neighborhoods together visually.

  ## Why ship together

  Each is small; the value is the bundle.
  - Hierarchy (1) without filter (2) is just naming convention.
  - Filter (2) without landing page (3) gives a list view but no
    overview.
  - Landing page (3) without suggest (4) makes scopes navigable but
    forces manual scope assignment.
  - Suggest (4) without tightened lint (5) doesn't get used.
  - PPR weighting (6) makes the existing map respect the scope
    structure rather than fighting it.

  ## Performance

  All operations remain SQL-table-scan or single-pass over edges.
  PPR runs once per page-render in <10ms for the meta-Doco. The
  multi-scope filter's HAVING clause is O(matches × scopes),
  negligible at this scale. At 10k entities, none of these become
  a bottleneck — but if they do, edges has the right indexes
  already.

alternatives:
  - name: Add `parent_scope_id` field instead of slash-in-name
    rejected_because: "More schema surface, more migration friction. Slashes-in-name reads naturally and SQL LIKE handles parent queries. Add the structured field later if it earns its keep."
  - name: Skip scope-weighted PPR; weight all edges equally
    rejected_because: "Scope membership is a stronger signal of relevance than most other edges (created_by, updated_by are weak; in_scope_of is intentional). Default-1 PPR misses this. The 2× boost is small enough not to overwhelm but big enough to nudge clusters together."
  - name: Make connectivity lint an error instead of warning
    rejected_because: "Would fail validation on the 8 existing bootstrap Rules. Per ADR-075's severity ladder, graduate to error after backfill — not now."
  - name: Per-type scope hierarchies (separate hierarchies for country/, user-flow/, etc.)
    rejected_because: "Premature. The flat scope-name space already supports multiple hierarchies via the path prefix. Per-type registries would need a separate Decision when usage shows the friction."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: torrenegra
decided_at: 2026-05-09T19:45:00Z

created_at: 2026-05-09T19:45:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-079 — Scope-driven discoverability

## Why now

A single Doco at scale needs to support multiple independent threads:
the user flows, the country-by-country payment policies, the bugs
reported by the board. Each is a different perspective on the same
underlying corpus. ADR-078 renamed tag → scope; this Decision turns
scopes into the *navigation primitive* that makes those perspectives
work in practice.

## What ships

Six small moves coordinated:

| # | Move | Where |
|---|---|---|
| 1 | Hierarchical scope names (slash convention) | `schema/doco.schema.json` |
| 2 | Multi-scope filter on `/e/<type>` lists | `routes/e.$type._index.tsx` |
| 3 | Scope landing pages (members dashboard + sub-scopes) | `routes/e.$type.$id.tsx` (when type === scope) |
| 4 | `suggested_scopes` in `/api/v1/suggest` | `packages/api/src/server.ts` |
| 5 | Connectivity lint tightened — Decisions + Actions need ≥1 scope | `packages/lints/src/connectivity.ts` |
| 6 | Scope-weighted Personalized PageRank | `packages/web/app/lib/pagerank.ts` + the two entity-detail routes |

Each moves the system one step closer to "any node is findable from
any of the perspectives it lives in."

## What it looks like

A user investigating French payments visits `/e/scope/<france-payment-id>`,
sees a dashboard of Intents, Decisions, Actions, Rules in scope, drills
into a Decision via the entity-detail page, finds the map weighted toward
other French payment work and across-scope links to the bugs the board
reported about the same flow. Each step uses the same scope mechanism
without separate machinery.

## What's deferred

- The host-mode entity-detail route doesn't yet have scope-landing
  rendering (only single-Doco does). Captured by the cleanup-sweep
  Action `action_01KR75ZTN7FYD0KG2NTHNA2W7X` — they share ~95% of
  structure and should be unified.
- Rules-driven type-specific scope minimums (the "rules say each Bug
  must be in a country/* scope" idea from the brainstorm). Big enough
  to deserve its own Decision once usage shows what shape it should
  take.
- LLM-based scope reranking on top of FTS. The OpenAI provider scaffold
  exists; not yet wired to `/api/v1/suggest`.
- Scope-aware PPR could weight by *shared scope count* (entities sharing
  3 scopes rank higher than those sharing 1). Today's 2× flat boost is
  the simpler version.
