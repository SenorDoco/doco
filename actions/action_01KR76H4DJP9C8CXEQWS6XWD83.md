---
id: action_01KR76H4DJP9C8CXEQWS6XWD83
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 17 — six scope-discoverability moves shipped: hierarchical names, multi-scope filter, scope landing pages, suggested_scopes API, tightened connectivity lint, scope-weighted PPR. Per ADR-079."

actor_id: claude-opus-4-7
verb: ship_scope_discoverability_bundle

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR76H4DAJ1ZR26ZTD69CQD8H   # ADR-079

follows:
  - decision_01KR76H4DAJ1ZR26ZTD69CQD8H
  - action_01KR74PX3E27FY526AE8AMD3HQ     # Phase 16 (tag→scope rename — predecessor)

inputs:
  user_direction: |
    "Let's actually do all of them from one to six."
    Six moves identified in the previous turn:
    1. Hierarchical scopes (slash namespace)
    2. Multi-scope filter on every list view
    3. Scope landing pages with curated views
    4. Auto-suggest scopes at write-time (API)
    5. Tighten the connectivity lint
    6. Scope-aware Personalized PageRank

outputs:
  source_files_changed:
    schema:
      - schema/doco.schema.json   # Scope.name regex now allows slashes
    typescript:
      - packages/web/app/lib/pagerank.ts            # PprEdge gains edge_type; PprOptions gains edgeWeight; weighted adjacency
      - packages/web/app/routes/e.$type.$id.tsx     # passes edge_type to PPR; weights in_scope_of=2; scope landing card with members + sub-scopes
      - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type.$id.tsx  # PPR weighting (host-mode; scope landing not yet — deferred)
      - packages/web/app/routes/e.$type._index.tsx  # ?scope=<id> filter (intersection default, ?scope_mode=any for union); chip UI
      - packages/api/src/server.ts                  # /api/v1/suggest returns suggested_scopes; aggregateSuggestedScopes helper
      - packages/lints/src/connectivity.ts          # Decision and Action also require ≥1 scope (warning); messages updated
    docs:
      - decisions/decision_01KR76H4DAJ1ZR26ZTD69CQD8H.md   # ADR-079 — full rationale + bundle composition
  e2e_verified:
    - "schema validates with the new regex; existing 6 flat scope names still pass"
    - "POST /api/v1/suggest returns matches + suggested_scopes (live test against meta-Doco; query 'agent invitation token redemption' returned scope_meta×5, scope_adr×3, scope_userflow×1)"
    - "/e/decision lists all 78 with scope filter chips at top"
    - "/e/decision?scope=scope_<bugfix-id> filters to 0 (correct — no Decisions tagged scope_bugfix)"
    - "/e/decision?scope=scope_<adr-id> filters to all 78 (every Decision is scope_adr by convention)"
    - "/e/scope/<scope_adr> renders the new scope landing card showing 25 decisions in scope, with lifecycle badges + 'See all decisions in this scope' link"
    - "Map (PPR) on entity-detail still renders correctly with the in_scope_of=2× weight"
    - "Connectivity lint with scope check on Decisions + Actions: 0 new warnings (every existing entity already has scopes)"
    - "All 10 packages green via pnpm -r test"

  what_was_NOT_changed:
    - "Host-mode scope landing — only single-Doco path got the curated dashboard; host-mode still renders the generic entity-detail. Captured by the cleanup-sweep Action (action_01KR75ZTN7FYD0KG2NTHNA2W7X) which would unify the two routes."
    - "Existing 6 scope names — kept flat (scope_adr, scope_bugfix, etc.) rather than retroactively hierarchized. New scopes can use slashes; existing ones don't migrate."
    - "Rules-driven type-specific scope minimums — deferred per ADR-079 'what's deferred' section."

started_at: 2026-05-09T19:35:00Z
ended_at: 2026-05-09T19:55:00Z

created_at: 2026-05-09T19:55:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 17 — Scope discoverability bundle

## What ships

Six coordinated moves, all in one pass per the user's directive
"do all of them from one to six." Each summarized in ADR-079; this
Action records the implementation:

1. **Hierarchical scope names** (1 line of regex change)
2. **Multi-scope filter on entity-list pages** (~50 LOC of loader +
   chip UI in `e.$type._index.tsx`)
3. **Scope landing pages** (~80 LOC of loader + JSX in
   `e.$type.$id.tsx`, gated on `type === "scope"`)
4. **`suggested_scopes` in `/api/v1/suggest`** (~45 LOC: the
   aggregateSuggestedScopes helper + response shape extension)
5. **Tightened connectivity lint** (~30 LOC: Decision and Action
   scope-presence checks added to the existing rule set)
6. **Scope-weighted PPR** (~10 LOC: PprEdge gains edge_type, PprOptions
   gains edgeWeight, the routes pass `(t) => t === "in_scope_of" ? 2 : 1`)

## Verification

| Surface | Result |
|---|---|
| `pnpm doco validate` | All entities valid |
| `pnpm doco lint` | 0 errors, 8 warnings (pre-existing bootstrap Rules) |
| `pnpm -r test` | All 10 packages green |
| `POST /api/v1/suggest` | Returns matches + suggested_scopes |
| `/e/decision?scope=<id>` | Filters via JOIN on edges; chip UI works |
| `/e/scope/<id>` | Renders members-by-type dashboard + sub-scope chips |
| Entity-detail map | PPR weighted; scope-shared neighbors rank closer |

## Why this matters at scale

The user's framing: a Doco that documents user flows AND payment
policies by country AND bugs reported by the board needs to be
navigable from any of those perspectives. ADR-078 made the rename;
ADR-079 + this Action make the navigation real. Now each scope is
both a filter (from any list) and a landing page (its own dashboard);
new entities get scope suggestions automatically; the graph map
respects scope structure.

## Deferred (per ADR-079)

- Host-mode entity-detail route doesn't yet have scope-landing
  rendering. Captured by the cleanup-sweep Action.
- Rules-driven type-specific scope minimums.
- LLM-based scope reranking on top of FTS.
- PPR weighting by *shared scope count* (not just flat 2× boost).
