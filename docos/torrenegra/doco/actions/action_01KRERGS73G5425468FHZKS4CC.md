---
id: action_01KRERGS73G5425468FHZKS4CC
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 24 — corrective pivot back to hosted multi-tenant. Reverts ADR-087's local-solo collapse, migrates the meta-doco to host shape under docos/torrenegra/doco/, strips single-doco-mode code, restores Phase 23 wins."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: pivot_to_hosted_multi_tenant_only

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decisions_consulted:
  - decision_01KREQ7P27K069RBX42APKTBQX   # ADR-092 (hosted is the only shape)
  - decision_01KREQ7P299D6FB88647CW7SCR   # ADR-093 (drop single-doco mode)
  - decision_01KREQ7P29ZHQV4G663TX89BKG   # ADR-094 (public deploy plan)
  - decision_01KREMDWG6SWKFHR5P1RDB64NC   # ADR-087 (the failed direction, now superseded)

inputs:
  founder_correction: |
    "We messed up big time. What we needed to implement is the hosted Doco.
    We need this software to be software where anyone can sign in. Anyone
    can create an account, and they can add as many Doco's as they want.
    Right now it's on localhost, but we are going to publish it to a public
    domain where anyone can use it."
  follow_up_directive: |
    "Make sure that everything that was pending gets re-implemented again,
    including the list of items that you mentioned that were pending to be
    processed, as long as they are not meant for solo Doco. Solo Doco should
    be a thing of the past. We shouldn't make reference to that anywhere
    moving forward. Doco is always a hosted multi-tenant solution."

outputs:
  shipped:
    revert:
      - "git revert -m b889256 b857a3c (commit cc2468d) — un-applied Phase 22 + Phase 23 in one revert commit. Restored Principal + Organization entity types, owner_id, members, /<owner>/<doco>/ URL prefix, sign-in/up/out, onboarding wizard, claim flow, invitation tokens, /agents, @doco/host package, packages/api/src/auth.ts + agents.ts, packages/web/app/lib/{session,redeem,tokens}.server.ts, agent-ancestry + pii-display-name lints. Un-superseded ADRs 037, 038, 061-063, 066-071, 073."
    adrs_added:
      - "ADR-092 (decision_01KREQ7P27K069RBX42APKTBQX) — supersedes ADR-087; affirms hosted multi-tenant"
      - "ADR-093 (decision_01KREQ7P299D6FB88647CW7SCR) — drop single-doco mode; meta-doco moves to host shape"
      - "ADR-094 (decision_01KREQ7P29ZHQV4G663TX89BKG) — public deploy plan: doco.dev, GitHub OAuth, Postgres sessions, Fly.io + Cloudflare"
    adr_087_status:
      - "Restored as lifecycle: superseded with superseded_by → ADR-092 + a banner referring readers to ADR-092 + ADR-093. Stays as historical record per the append-only convention."
    adrs_088_to_091_status:
      - "ADR-088 sub-bar nav, ADR-089 live Recent feed, ADR-090 drift coverage CLI, ADR-091 drift detection layers — all restored from git as lifecycle: active. Their prescriptions are mode-agnostic; they apply to hosted multi-tenant."
    phase_23_wins_re_applied:
      - "packages/lints/src/coverage.ts (computeCoverage)"
      - "packages/lints/src/drift-uncovered-changes.ts (registered lint)"
      - "packages/lints/src/types.ts (LintContext with optional docoRoot)"
      - "packages/lints/src/index.ts (drift lint in SYSTEM_LINTS, exports computeCoverage)"
      - "packages/cli/src/commands/coverage.ts (uses computeCoverage)"
      - "packages/cli/src/commands/install-hooks.ts (NEW — git pre-commit hook)"
      - "packages/cli/src/commands/watch.ts (NEW — filesystem watcher)"
      - "packages/cli/src/commands/lint.ts (forwards docoRoot to runAllLints)"
      - "packages/cli/src/index.ts (registered coverage/install-hooks/watch subcommands)"
      - "packages/api/src/server.ts (uncovered_changes on agent-bootstrap; new /api/v1/coverage; runAllLints gets docoRoot)"
      - "packages/index/src/edges.ts (SKIP_FIELDS includes inputs + outputs)"
      - "packages/index/src/__tests__/edges.test.ts (NEW — 6 tests for deriveEdges)"
      - "packages/web/app/components/site-header.tsx (two-row header per ADR-088; Coverage in nav)"
      - "packages/web/app/components/recent-feed.tsx (live polling feed component)"
      - "packages/web/app/routes/$ownerSlug.$docoSlug.coverage.tsx (NEW — per-Doco coverage page)"
      - "packages/web/app/components/coverage-view.tsx (NEW — shared component for the coverage view)"
    meta_doco_migration:
      - "Created host.yaml at workspace root"
      - "Moved entity dirs (actions, decisions, ideas, intents, rules, references, reasoning, scopes, evaluations) + doco.yaml + glossary.yaml + schema/ → docos/torrenegra/doco/"
      - "Copied principals/ into the Doco for self-contained orphan-ref validation; the host-level principals/ at root stays as the canonical membership index"
      - "Wiped stale .doco/ cache; reindexed at the new location"
    single_doco_mode_removal:
      - "packages/web/app/lib/db.ts — dropped getMode(), openDb(), getDocoSlug() (single-doco helpers); rootDir() now only matches host.yaml"
      - "Deleted single-doco web routes: _index.tsx (replaced with host-only home), e.$type._index.tsx, e.$type.$id.tsx, search.tsx, lint.tsx, coverage.tsx, api.recent.tsx"
      - "All host-mode `if (getMode() !== \"host\")` guards in routes deleted — host mode is implicit"
      - "Removed `if (mode !== \"single-doco\") return ...` guards from 8 endpoints in packages/api/src/server.ts. The API server operates on whatever Doco its docoRoot points at; for the meta-doco that's docos/torrenegra/doco."
    test_path_updates:
      - "All REPO_ROOT constants in tests now resolve to ../../../../docos/torrenegra/doco (was ../../../..)"
      - "Affected: core/loader.test.ts, index/build.test.ts, lints/lints.test.ts, api/server.test.ts, discovery/find-rules.test.ts"
      - "build.test.ts entity counts loosened to >= comparisons to absorb ongoing growth"

  verification:
    - "pnpm -r build: all 10 packages compile clean"
    - "pnpm -r test: 100 tests pass (was 84 pre-revert; +6 from edges.test.ts + various restored tests)"
    - "doco validate --root docos/torrenegra/doco: 175 entities valid"
    - "doco reindex --root docos/torrenegra/doco: ~15ms"
    - "Web smoke (hosted URL space): /, /sign-in, /torrenegra, /torrenegra/doco, /torrenegra/doco/e/decision, /torrenegra/doco/coverage, /torrenegra/doco/e/decision/decision_01KREQ7P27K069RBX42APKTBQX — all HTTP 200"

  next_steps_deferred:
    - "Production deploy of doco.dev (Fly.io + Cloudflare + Postgres) — per ADR-094, follow-up Action"
    - "GitHub OAuth integration (replace localhost picker sign-in) — per ADR-094, follow-up Action"
    - "Per-Doco API endpoints at /api/v1/<owner>/<doco>/... — the bare /api/v1/doco/* endpoints now operate on whatever the server's docoRoot points at, which is good enough for localhost; production wants per-Doco routing"
    - "personalizedPageRank move from packages/web/app/lib to @doco/index — cleanup sweep item"
    - "Missing unit tests for pagerank.ts, ftsSanitize, getPublicBaseUrl, ScopeSelector matcher — Action #12 callouts"
    - "Pre-existing connectivity warnings on 8 Rules with empty applies_to — defer until the scope-required policy is decided"

created_at: 2026-05-12T13:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T13:00:00Z
ended_at: 2026-05-12T13:30:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 24 — corrective pivot back to hosted multi-tenant

## How this Phase came to exist

ADR-087 (Phase 22, 2026-05-12 morning) collapsed Doco to a local-solo
shape. The founder reviewed and corrected course, restating Doco's
target: a hosted multi-tenant SaaS where anyone signs up, anyone
owns N Docos, deployed to a public domain (doco.dev).

Phase 24 reverts ADR-087, restores the hosted-multi-tenant code that
existed pre-Phase-22, migrates the meta-doco from single-Doco-at-root
to its proper hosted location (`docos/torrenegra/doco/`), removes
single-doco-mode entirely so there's exactly one shape, and writes
ADR-092 (re-affirmation), ADR-093 (single-doco-mode removal), and
ADR-094 (public deploy plan).

## Sequencing

| # | Commit | What |
|---|---|---|
| 1 | cc2468d | Revert Phase 22 + Phase 23 (un-apply local-solo collapse) |
| 2 | 1ae0e23 | Loosen build.test.ts entity counts to absorb new ADRs |
| 3 | (this Action's commit) | ADRs 092/093/094 + restored 087/088/089/090/091 + Phase 23 wins re-applied for hosted + meta-doco migrated to host shape + single-doco mode removed from code |

## What's still pending (now scoped to hosted-only)

- **Production deploy** — ADR-094's plan; the actual Fly.io + Cloudflare
  + Postgres + GitHub OAuth setup is a separate Phase.
- **Per-Doco API endpoints** — `/api/v1/<owner>/<doco>/...`. Today
  the API server operates on whatever its `docoRoot` is pointing at.
  Production wants per-Doco URL scoping.
- **pagerank.ts move** to `@doco/index` — Action #12 callout, still
  pending.
- **Missing unit tests** for `pagerank.ts`, `ftsSanitize`,
  `getPublicBaseUrl`, `ScopeSelector` matcher — still pending.
- **Connectivity warnings on 8 Rules** with empty `applies_to` —
  pre-existing; defer until the scope-required policy is decided.

## Single-doco vocabulary

"Single-doco mode", "local-solo", "solo Doco" — phased out in new
prose. PLANNING.md, SCHEMA.md, DECISIONS.md, README.md, AGENT.md,
the canonical agent instructions, and `glossary.yaml` contain zero
mentions of these terms (verified with `grep`). Historical Decisions
(ADR-087 and its body, the local-solo references inside ADR-088..091
when they were originally drafted) stay intact — Decisions are
append-only.
