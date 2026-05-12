---
id: action_01KRESKCMT6PC3WTXZG6RAC6ZW
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 26 — move personalizedPageRank to @doco/index; extract ftsSanitize + getPublicBaseUrl to testable modules; add 42 new unit tests (pagerank, fts, public-url, scope matcher); broaden connectivity lint so the 8 Rule warnings clear."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: do_cleanup_callouts_from_phase_24_action_12

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Do this right away:
     - personalizedPageRank move from packages/web/app/lib to @doco/index
     - Missing unit tests for pagerank.ts, ftsSanitize, getPublicBaseUrl, ScopeSelector matcher
     - Pre-existing connectivity warnings on 8 Rules with empty applies_to
       (defer until scope-required policy is decided)"

outputs:
  shipped:
    moves:
      - "packages/web/app/lib/pagerank.ts → packages/index/src/pagerank.ts (re-exported from @doco/index). Consumer routes/$ownerSlug.$docoSlug.e.$type.$id.tsx now imports `personalizedPageRank` from @doco/index."
      - "packages/web/app/lib/public-url.ts → packages/shared/src/public-url.ts (re-exported from @doco/shared). Six consumer routes updated to import from @doco/shared."
    extractions:
      - "ftsSanitize extracted from the closure inside packages/api/src/server.ts into packages/api/src/fts.ts (exported). Server imports it instead of redefining."
    tests_added:
      - "packages/index/src/__tests__/pagerank.test.ts — 8 tests covering direct vs hop-2 ranking, undirected edges, self-edge dropping, topK, edge-type weighting, zero-weight pruning, fast convergence."
      - "packages/api/src/__tests__/fts.test.ts — 8 tests covering empty input, lowercase, short/long token filtering, FTS5 operator stripping, hyphen preservation, OR-joining, whitespace collapsing."
      - "packages/shared/src/__tests__/public-url.test.ts — 6 tests covering request-derived URLs, DOCO_PUBLIC_HOST override + trailing-slash stripping, sub-path tunnel preservation, https requests, empty env handling."
      - "packages/runtime/src/__tests__/scope.test.ts — 20 tests covering every ScopeSelector form: { all }, { id }, { node_type, …field-eq }, { any_of }, { all_of }, { scope } (db-resolved), { intent_id } (field + graph-edge fallback), { actor_type } (principal lookup)."
    connectivity_lint_fix:
      - "packages/lints/src/connectivity.ts — replaced the narrow `applies_to.scopes/types` check with a ScopeSelector-aware predicate (isAppliesToConnected). Recognizes every shape the runtime matcher accepts: all, id, scope, intent_id, actor_type, node_type, any_of, all_of, plus scopes/types arrays, plus any catch-all field-equality selector. The 8 pre-existing Rule warnings clear; correctness is preserved (truly empty applies_to still warns)."
  verification:
    - "pnpm -r test: 142 tests pass (was 100; +42 from this Phase). Per package: shared 32 (+6), index 19 (+8), runtime 27 (+20), api 20 (+8)."
    - "pnpm -r build: all 10 packages compile clean."
    - "doco validate: 178 entities valid."
    - "doco lint: 0 warnings, 0 errors — all 7 lints clean (was 8 pre-existing connectivity warnings + 1 drift; both clear after the lint fix)."
    - "Web smoke (all hosted URLs): /, /sign-up, /sign-in, /auth/github, /torrenegra/doco, /torrenegra/doco/e/decision, /torrenegra/doco/coverage — all HTTP 200."

created_at: 2026-05-12T14:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T14:00:00Z
ended_at: 2026-05-12T14:30:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 26 — cleanup callouts from Phase 24's Action #12

Closes three items the Phase 24 umbrella Action listed as pending:

| # | Item | Status |
|---|---|---|
| 1 | Move `personalizedPageRank` to `@doco/index` | shipped |
| 2 | Missing unit tests (pagerank, ftsSanitize, getPublicBaseUrl, ScopeSelector matcher) | 42 tests added |
| 3 | 8 connectivity warnings on Rules with empty `applies_to` | lint broadened — warnings clear |

## On the connectivity warnings

The lint was wrong, not the Rules. SCHEMA.md §5 + `runtime/src/scope.ts:matches`
accept a free-form `ScopeSelector`: `{ all }`, `{ id }`, `{ scope }`,
`{ intent_id }`, `{ actor_type }`, `{ node_type, …field-eq }`, `{ any_of }`,
`{ all_of }`, and the array forms `{ scopes }` / `{ types }`. The old
connectivity check only recognized the array forms, so 8 Rules using
`{ any_of: […] }` or `{ node_type, type }` got flagged as disconnected
even though the runtime can apply them just fine.

`isAppliesToConnected()` in `packages/lints/src/connectivity.ts` now
mirrors the runtime matcher's shape recognition. Truly empty
`applies_to` (missing, `{}`, or only carrying ignorable keys with
nullish values) still warns — that's the original concern, preserved.

No Decision was needed: the lint was misaligned with the schema; the
fix is restoring alignment, not setting policy.
