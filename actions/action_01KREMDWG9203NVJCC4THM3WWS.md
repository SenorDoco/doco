---
id: action_01KREMDWG9203NVJCC4THM3WWS
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 22 — local-solo collapse (ADR-087) + sub-bar nav (ADR-088) + live Recent feed (ADR-089) + drift detection CLI (ADR-090). Backlog grooming closes 7 Actions; principals/organizations/auth/onboarding/host gone."

actor_id: claude-opus-4-7
verb: collapse_to_local_solo_and_groom_backlog

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decisions_consulted:
  - decision_01KREMDWG6SWKFHR5P1RDB64NC   # ADR-087 (local-solo collapse)
  - decision_01KREMDWG8X2SSB3FZHHVW4BRP   # ADR-088 (sub-bar nav)
  - decision_01KREMDWG8FMBDEHP245T5D6WA   # ADR-089 (live Recent feed)
  - decision_01KREMDWG839EYEJ12WFHERMCM   # ADR-090 (drift detection)
  - decision_01KREJDGKVBHGARG3ATJ80YBZ4   # ADR-086 (knowledge in Doco)

inputs:
  founder_direction: |
    "From the list of pending items, kill 2, 3, 4, 5. Implement all
    other to-dos. And if there is anything else missing to complete
    the renaming into Doco, go ahead and do it as well. Once you're
    done with all of the changes, test properly, identify issues,
    fix them, and repeat."
  backlog_at_session_start:
    - "13 planned Actions; 4 to kill (#2 Aligno rename, #3 Aligno brand, #4 logotype, #5 isotype flip)"
    - "Underlying: in-flight Evalo→Doco rename had 305 uncommitted files"

outputs:
  shipped:
    schema_v0_2:
      - schema/doco.schema.json
      - packages/cli/templates/doco.schema.json
    code_deletions:
      - packages/host/ (entire package)
      - packages/api/src/auth.ts
      - packages/api/src/agents.ts
      - packages/api/src/__tests__/invitation.test.ts
      - packages/cli/src/commands/agent.ts
      - packages/cli/src/commands/invite.ts
      - packages/cli/src/commands/host.ts
      - packages/lints/src/agent-ancestry.ts
      - packages/lints/src/pii-display-name.ts
      - packages/web/app/lib/session.ts
      - packages/web/app/lib/redeem.server.ts
      - packages/web/app/lib/tokens.server.ts
    route_deletions:
      - packages/web/app/routes/sign-in.tsx
      - packages/web/app/routes/sign-out.tsx
      - packages/web/app/routes/sign-up.tsx
      - packages/web/app/routes/new-doco.tsx
      - packages/web/app/routes/new-org.tsx
      - packages/web/app/routes/agents._index.tsx
      - packages/web/app/routes/agents.new.tsx
      - packages/web/app/routes/claim.\$token.tsx
      - packages/web/app/routes/invite.tsx
      - packages/web/app/routes/invite.\$token.tsx
      - packages/web/app/routes/invite.\$token[.]json.tsx
      - packages/web/app/routes/onboarding.create._index.tsx
      - packages/web/app/routes/onboarding.create.agent.tsx
      - packages/web/app/routes/onboarding.create.human.tsx
      - packages/web/app/routes/onboarding.join._index.tsx
      - packages/web/app/routes/onboarding.join.agent.tsx
      - packages/web/app/routes/onboarding.join.human.tsx
      - packages/web/app/routes/\$ownerSlug._index.tsx
      - packages/web/app/routes/\$ownerSlug.\$docoSlug._index.tsx
      - packages/web/app/routes/\$ownerSlug.\$docoSlug.e.\$type.\$id.tsx
      - packages/web/app/routes/\$ownerSlug.\$docoSlug.e.\$type._index.tsx
      - packages/web/app/routes/\$ownerSlug.\$docoSlug.lint.tsx
      - packages/web/app/routes/\$ownerSlug.\$docoSlug.scopes.new.tsx
      - packages/web/app/routes/\$ownerSlug.\$docoSlug.search.tsx
      - packages/web/app/routes/api.suggest-scopes.tsx
    code_rewrites:
      - packages/api/src/server.ts (dropped auth middleware, invitation/agents endpoints, dual-mode branches)
      - packages/api/src/index.ts (removed auth export)
      - packages/cli/src/index.ts (unregistered host/invite/agent subcommands; registered coverage)
      - packages/cli/src/commands/serve.ts (dropped --require-token, --as-principal)
      - packages/cli/src/commands/init.ts (local-solo shape; no Principal stub)
      - packages/cli/tsconfig.json (removed ../host reference)
      - packages/api/tsconfig.json (removed ../host reference)
      - packages/index/src/migrate.ts (dropped principal + organization tables; relaxed doco_root.owner_id)
      - packages/index/src/insert.ts (dropped principal/organization inserts)
      - packages/index/src/__tests__/build.test.ts (counts no longer assume principal/organization)
      - packages/lints/src/index.ts (removed agent-ancestry + pii-display-name from registry)
      - packages/lints/src/__tests__/lints.test.ts (removed agent-ancestry test)
      - packages/runtime/src/check.ts (actor.type derived from string convention)
      - packages/core/src/paths.ts (ENTITY_DIRS no longer includes principal/organization)
      - packages/core/src/__tests__/loader.test.ts (no more principal count assertion)
      - packages/shared/src/branded.ts (NODE_TYPES — removed principal/organization)
      - packages/shared/src/entities.ts (removed Principal + Organization types; actor fields now ActorString)
      - packages/shared/src/__tests__/branded.test.ts (post-collapse type set)
      - packages/web/app/routes.ts (route table reduced to local-solo)
      - packages/web/app/routes/_index.tsx (single-Doco-only loader + RecentFeed integration)
      - packages/web/app/components/site-header.tsx (two-row header per ADR-088)
      - packages/web/vite.config.ts (removed @doco/host from noExternal)
      - packages/web/package.json (removed @doco/host dep)
      - packages/api/package.json (removed @doco/host dep)
      - packages/cli/package.json (removed @doco/host dep)
      - packages/api/src/__tests__/server.test.ts (delete_doco tests use ActorString)
      - packages/cli/src/__tests__/init-and-validate.test.ts (local-solo shape)
    code_additions:
      - packages/cli/src/commands/coverage.ts (`doco coverage` — ADR-090 drift detection)
      - packages/web/app/components/recent-feed.tsx (live polling + IntersectionObserver — ADR-089)
      - packages/web/app/routes/api.recent.tsx (since-based feed resource route)
    entity_migration:
      - /tmp/doco-collapse-migrate.mjs (one-off; rewrote 322 principal IDs across 166 files; stripped owner_id + members from doco.yaml)
      - /tmp/supersede-adrs.mjs (flipped 12 ADRs to lifecycle: superseded with superseded_by → ADR-087)
      - principals/ + organizations/ directories deleted
      - assets/proposed-aligno-rebrand/ deleted
    backlog_groomed:
      - action_01KR441EACS9CF3JXJBGJV019P (Aligno rename) — abandoned
      - action_01KR6G9454VZM160S7HHZWBVBY (Aligno brand) — abandoned
      - action_01KR441EABNCVK39BSWQRGTDHX (logotype) — abandoned
      - action_01KR6VVTN0D1RN6DM6G4NYG9DV (isotype flip) — abandoned
      - action_01KR6KS73SZHYSFP5RQMHRX3PA (claim flow) — abandoned (surface gone)
      - action_01KR94Z93KAXCH5EAP0T41DF77 (atomic createDocoInHost) — abandoned (helper gone)
      - action_01KR6JTFDRV2GQ20DKRKKWVD93 (no-backcompat sweep) — succeeded
      - action_01KR90QEHWC22057MP3WFB2N0W (remove single mode) — succeeded
      - action_01KR6VVTN0JGKYYREZEQ074MKA (menu out of app bar) — succeeded
      - action_01KR6VVTN0R68ANTBX42M4GEWK (real-time Recent feed) — succeeded
      - action_01KR6W4643E036C8MJ3Z7GEFFM (rename Doco refs) — succeeded
  superseded_adrs:
    - ADR-037 ADR-038 ADR-061 ADR-062 ADR-063 ADR-066 ADR-067 ADR-068 ADR-069 ADR-070 ADR-071 ADR-073
  test_results:
    - "pnpm -r test: all 84 tests pass across 9 packages"
    - "pnpm -r build: all 10 packages compile clean"
    - "doco validate: 167 entities valid"
    - "doco lint: 7 pre-existing connectivity warnings on Rules (no regressions)"

  not_yet_shipped:
    - "/coverage web page (deferred — ADR-090 §what's-not-shipping)"
    - "doco install-hooks pre-commit (deferred)"
    - "uncovered_changes field on /api/v1/agent-bootstrap (deferred — let CLI prove the data shape first)"
    - "drift-uncovered-changes lint (deferred until bootstrap field stabilizes)"
    - "filesystem watcher auto-reindex (deferred per ADR-089's follow-up)"
    - "Action #12 cleanup sweep (open-ended; partial work shipped via the collapse — see ADR-087's deletion list — but the abstraction-extraction pass on duplicated entity-detail routes is deferred since those host-mode routes no longer exist anyway)"

created_at: 2026-05-12T11:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T10:00:00Z
ended_at: 2026-05-12T11:45:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 22 — local-solo collapse + backlog groom

Single commit-class of work captured here so an agent reading the
Recent feed sees one Action, not twelve. Each individual backlog
item still has its own completion_note pointing at the relevant
ADR; this Action stitches them together.

## What's outside this Action's scope

- Action #12 (cleanup + abstraction sweep) wasn't run as a
  dedicated pass. The duplicated entity-detail-route extraction it
  called out is now moot — the host-mode `$ownerSlug.$docoSlug.*`
  routes are gone, so there's only one copy of each route to
  maintain. The remaining cleanup candidates (TokenStore moved, lint
  test setup helpers, FIELD_TO_EDGE_TYPE auto-derivation) live in
  their own future Action when the surface stabilizes after one
  more iteration on the local-solo shape.
- Filesystem watcher for auto-reindex on entity write (ADR-089's
  follow-up). Captured as a deferred item; build it when the manual
  reindex loop gets annoying.
- The `uncovered_changes` bootstrap field (ADR-090). The `doco
  coverage` CLI must prove the data shape across a couple of
  sessions before the bootstrap commits to exposing it.
