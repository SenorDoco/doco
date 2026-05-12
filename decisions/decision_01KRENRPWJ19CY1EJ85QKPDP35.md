---
id: decision_01KRENRPWJ19CY1EJ85QKPDP35
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Phase 23 layers ADR-090's drift detection across Doco: a registered lint, the agent-bootstrap response, a /coverage web page, a pre-commit hook. Pairs with `doco watch` so reindex tracks entity writes."

slug: drift-detection-layers
number: "ADR-091"
follows:
  - decision_01KREMDWG839EYEJ12WFHERMCM   # ADR-090 (doco coverage CLI)
  - decision_01KREMDWG8FMBDEHP245T5D6WA   # ADR-089 (live Recent feed)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "ADR-090 shipped `doco coverage` as the first surface for drift detection. The follow-ups it deferred — registered lint, bootstrap field, web page, pre-commit hook — were all 'wait until the data shape proves itself.' The CLI proved out. What do the layered surfaces look like?"
chosen: |
  Ship the four follow-ups together as a single Phase, plus the
  filesystem watcher that ADR-089 deferred. The coverage logic
  factors into one shared function (`computeCoverage(docoRoot)`) that
  every surface consumes.

  ### Layered surfaces

  1. **Shared `computeCoverage(docoRoot)`** lives in `@doco/lints`
     (alongside the other lints). Returns `{ modified, covered,
     uncovered }`. Same algorithm as ADR-090: grep each modified
     file's path + basename against the concatenated text of every
     Action body.
  2. **`drift-uncovered-changes` lint** registered in `SYSTEM_LINTS`.
     Requires `ctx.docoRoot`; emits one warning when uncovered files
     exist, including a 3-file sample in the message. The Lint type
     gains an optional `ctx: LintContext` parameter; existing lints
     ignore it.
  3. **`uncovered_changes` on `/api/v1/agent-bootstrap`** — a
     `{ count, sample[10] }` object. An agent that fetches the
     bootstrap sees drift before its first user-facing tool use.
  4. **`/coverage` web page** — renders modified/covered/uncovered
     badges + the full uncovered list, with a link to `/e/action`
     for capture. Added to the sub-bar nav.
  5. **`doco install-hooks`** writes a `.git/hooks/pre-commit` that
     shells out to `doco coverage` and either warns (default) or
     blocks (`--enforce`). Refuses to overwrite an existing
     non-Doco hook.

  ### ADR-089 follow-up: `doco watch`

  Filesystem watcher over the entity directories + `doco.yaml`.
  Debounces by 250ms (configurable) and triggers a full reindex on
  any change. Pairs with the live Recent feed (ADR-089) so new
  entities appear in the next 5-second poll without a manual
  `doco reindex`. SIGINT-clean.

  ### Cleanup wins folded in

  - **FIELD_TO_EDGE_TYPE noise.** `Action.inputs` and `Action.outputs`
    are free-form bags (`founder_direction`, `asset_files`,
    `completion_note`, etc.) — walking them produced pseudo-edges
    like `inputs.assets_provided_by` that aren't real relationships.
    Added both fields to SKIP_FIELDS in `packages/index/src/edges.ts`.
  - **Missing test for edges.ts.** Six tests cover the canonical
    cases: empty entity, mapped field names, self-edge drop,
    cross-Doco namespacing, Reasoning premises, and the `inputs` /
    `outputs` skip.

alternatives:
  - name: Ship each layer in a separate Phase
    rejected_because: "Each surface is small (≤ 100 LoC). Bundling lets them share one ADR and one Action, with one round of test + commit. The CLI already proved the data shape; layering doesn't add risk."
  - name: Block commits by default (strict pre-commit)
    rejected_because: "Too aggressive while we're still learning the false-positive envelope. Default warn-only; `--enforce` flag for callers who want hard gating."
  - name: Use a filesystem watcher in `doco serve` instead of a separate `doco watch` command
    rejected_because: "Two concerns — serving the API and tracking the cache — orthogonal lifecycles. Keep them runnable separately; compose later if usage shows they always run together."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-12T12:00:00Z

created_at: 2026-05-12T12:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-091 — Drift-detection layered surfaces + watch + cleanup

## Verification

- `pnpm -r test` → 90 tests pass (was 84 before this Phase; +6 from `edges.test.ts`)
- `pnpm -r build` → all 9 packages compile clean
- `doco validate` → 170 entities valid
- `doco lint` → drift-uncovered-changes lint surfaces 1 warning (in addition to pre-existing connectivity warnings on Rules)
- Web smoke: `/coverage` renders modified / covered / uncovered with the live uncovered list; sub-bar nav highlights "Coverage" via `aria-current="page"`.
- `GET /api/v1/agent-bootstrap` → response now includes `uncovered_changes: { count, sample[10] }` and a `drift-uncovered-changes` entry in `known_issues`.
- `doco install-hooks --help`, `doco watch --help`: both surface usage.

## What this enables

An agent starting a Doco session now sees:

- **At session start** (bootstrap): "previous session left N files modified without recording Actions — investigate or capture before continuing."
- **On every commit** (pre-commit hook, when installed): a warning listing uncovered files, with a one-line escape hatch (`--no-verify`).
- **On every `doco lint` run**: the drift lint shows up alongside connectivity / orphan-reasoning / follows-cycle / bugfix-guard.
- **Inside the web UI**: `/coverage` shows the live state and links to `/e/action` for capture.

The five surfaces share one `computeCoverage(docoRoot)` so a future
change to the algorithm (e.g., switching from grep to a structured
`Action.outputs.source_files_changed` field) updates everything in
lockstep.
