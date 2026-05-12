---
id: action_01KRENRPWMQNT68BKMXNEMZWEN
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 23 — ship every ADR-090 drift-detection follow-up (lint, bootstrap field, web page, pre-commit hook), the `doco watch` watcher (ADR-089 follow-up), and the FIELD_TO_EDGE_TYPE cleanup + edges.test.ts."

actor_id: claude-opus-4-7
verb: ship_phase_23_drift_layers_and_cleanup

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decisions_consulted:
  - decision_01KRENRPWJ19CY1EJ85QKPDP35   # ADR-091 (this Phase's source decision)
  - decision_01KREMDWG839EYEJ12WFHERMCM   # ADR-090 (coverage CLI)
  - decision_01KREMDWG8FMBDEHP245T5D6WA   # ADR-089 (live Recent feed)

inputs:
  founder_direction: |
    "Do not stop to ask unnecessary questions, BTW. Complete everything."

outputs:
  shipped:
    shared_module:
      - packages/lints/src/coverage.ts (computeCoverage + types extracted from CLI)
      - packages/lints/src/drift-uncovered-changes.ts (registered Lint)
      - packages/lints/src/index.ts (added drift-uncovered-changes to SYSTEM_LINTS; exported computeCoverage)
      - packages/lints/src/types.ts (added LintContext with optional docoRoot)
    cli:
      - packages/cli/src/commands/coverage.ts (now uses computeCoverage from @doco/lints)
      - packages/cli/src/commands/install-hooks.ts (NEW — writes .git/hooks/pre-commit, warn-only by default, --enforce flag)
      - packages/cli/src/commands/watch.ts (NEW — filesystem watcher over entity dirs + doco.yaml; debounced reindex)
      - packages/cli/src/commands/lint.ts (forwards docoRoot to runAllLints so the drift lint can read git)
      - packages/cli/src/index.ts (registered install-hooks + watch subcommands)
    api:
      - packages/api/src/server.ts (added uncovered_changes to /api/v1/agent-bootstrap; new GET /api/v1/coverage; forwards docoRoot to runAllLints)
    web:
      - packages/web/app/routes/coverage.tsx (NEW — /coverage page using computeCoverage)
      - packages/web/app/routes.ts (registered /coverage)
      - packages/web/app/components/site-header.tsx (added Coverage to sub-bar nav)
      - packages/web/app/lib/db.ts (dropped host-mode helpers — getMode, docoPath, openDocoDb, readDocoFullSlug — leftovers from before ADR-087)
    indexer_cleanup:
      - packages/index/src/edges.ts (SKIP_FIELDS now includes inputs + outputs; kills noisy pseudo-edges like `inputs.assets_provided_by`)
      - packages/index/src/__tests__/edges.test.ts (NEW — 6 tests for deriveEdges)
  verification:
    - "pnpm -r test: 90 tests pass across 9 packages (was 84; +6 from edges.test.ts)"
    - "pnpm -r build: 9 packages compile clean"
    - "doco validate: 170 entities valid"
    - "doco lint: drift-uncovered-changes lint registered and emitting (+1 warning for 6 uncovered files this session); connectivity warnings unchanged"
    - "doco coverage: 6 uncovered files (this session's own edits — meta!)"
    - "GET /api/v1/agent-bootstrap: response includes uncovered_changes: { count: 6, sample: [...] } and drift lint in known_issues"
    - "Web /coverage: HTTP 200, renders Modified/Covered/Uncovered badges + uncovered file list"
    - "Web /, /e/decision, /e/action, /e/scope, /lint, /search, detail pages, /api/recent: all HTTP 200"

created_at: 2026-05-12T12:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T11:45:00Z
ended_at: 2026-05-12T12:00:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 23 — drift detection layered + watch + cleanup

ADR-090 deferred four follow-up surfaces (lint, bootstrap field, web
page, pre-commit hook) until the CLI proved out. Phase 23 ships all
four together, plus the ADR-089 follow-up (`doco watch` filesystem
watcher), plus the Phase 22 cleanup callout on edge-derivation noise.

## What an agent sees now

A fresh agent connecting via `GET /api/v1/agent-bootstrap` receives
its `canonical_instructions` *and* a `uncovered_changes: { count,
sample }` object naming the working-tree drift the previous session
left behind. On commit, the pre-commit hook (if installed) prints the
same data. The `/coverage` web page shows it interactively. The
`drift-uncovered-changes` lint surfaces it on every `doco lint` run.

Five surfaces, one shared function — `computeCoverage(docoRoot)` in
`@doco/lints`. Future algorithm changes update everything in lockstep.

## What this Action did NOT touch

- A web admin to install/uninstall the pre-commit hook. CLI is
  sufficient for now.
- An entity-file watcher inside `doco serve` (vs. the separate
  `doco watch`). Composing them is a one-liner if usage shows they
  always run together — but lifecycles differ today.
- Tightening the heuristic from substring grep to structured
  `Action.outputs.source_files_changed` lookup. Premature; the
  current heuristic catches the high-leverage cases and false
  positives have been minor.
