---
id: decision_01KREMDWG839EYEJ12WFHERMCM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Ship `doco coverage` — drift detection that grep-matches every modified file against every Action body. Reports the uncovered set. Bootstrap field, pre-commit, web page layer on later."

slug: drift-detection-doco-coverage
number: "ADR-090"
follows:
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized bootstrap — where uncovered_changes will land)
  - decision_01KREJDGKVBHGARG3ATJ80YBZ4   # ADR-086 (knowledge lives in Doco — coverage is the operational enforcement)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Agents (and humans) demonstrably ship work without recording it (the Phase-21-six-changes-no-Action case). Doco's value depends on the trail. How do we surface 'you've changed code without writing an Action' before it rots into invisible drift?"
chosen: |
  Ship the simplest viable detector first: `doco coverage` walks git
  for modified files and reports any that don't appear in any
  Action's body text. Run before commit; if files are uncovered,
  write the missing Action.

  ### Algorithm

  1. Collect modified files via `git status --porcelain -uall`.
     Optionally add committed-since-revision range (`--since HEAD~5`).
  2. Filter the standard ignore list (lockfiles, build outputs,
     .doco/, node_modules).
  3. Read every `actions/action_*.md` into one big text blob.
  4. For each modified file, check `blob.includes(fullpath)` OR
     `blob.includes(basename)`. The basename fallback catches
     Actions that reference a file by basename only.
  5. Report uncovered files; exit 1 if any.

  Conservative on purpose: false positives (a file mentioned in
  passing in some unrelated Action) are acceptable. The goal is to
  surface the *un*covered side, where the agent silently shipped
  work.

  ### What's *not* shipping today (deferred to follow-ups)

  - **`uncovered_changes` field on the bootstrap response.** Agents
    starting in a Doco-tracked repo could see "previous session
    left N files modified without a recording Action — investigate
    or capture." Lands once the `doco coverage` exit code stabilizes.
  - **`doco install-hooks` pre-commit hook.** Soft default; skippable
    with `--no-verify`. Lands once we've used the CLI for a couple
    of sessions and the false-positive shape is understood.
  - **`/coverage` web page.** Click an uncovered file → prefilled
    Action template. Lands after the CLI proves the data shape is
    useful.
  - **`drift-uncovered-changes` lint.** Same data as the CLI surfaced
    as a first-class lint. Lands when uncovered_changes is on
    bootstrap so the lint runs offline.

  Three of these are now follow-up Actions; the fourth (lint) is
  deferred until the underlying signal proves itself.

alternatives:
  - name: Pre-commit hook that blocks on any uncovered file
    rejected_because: "Too aggressive for v0. Will hit every developer with a typo fix, version bump, formatting pass. Soft-fail nudges are the right starting volume."
  - name: Use Action.outputs.source_files_changed as the authoritative claim
    rejected_because: "The field is hand-written and ad-hoc — many Actions don't fill it. A free-text grep against the entire Action body is more forgiving and matches what's actually written today. Tighten later if shape stabilizes."
  - name: Snapshot the working tree on agent session start; diff at end
    rejected_because: "Requires the agent's session to bracket the work (start + end events). The CLI runs after the fact and works for both human and agent. Snapshot-on-start could be a complementary signal later, not the primary one."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-12T11:30:00Z

created_at: 2026-05-12T11:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-090 — Drift detection via `doco coverage`

## Why this earns its keep now

Phase 21 surfaced the drift directly: the agent shipped six
user-visible changes (inline scope edit, reparent/delete, LLM
suggestions, /scopes/new reframing, .env auto-load, new isotype +
wordmark, Phase 20 schema-fix) without writing a single Action until
the user explicitly prompted "what's missing for a new agent's
bootstrap?" Without a detector, that drift stays silent.

ADR-086 codified the principle ("Doco is the memory"); ADR-090 ships
the operational nudge. The two together turn the convention into
something you can actually catch yourself violating.

## Implementation

`packages/cli/src/commands/coverage.ts` — single command, ~120 LoC.
Registered as `doco coverage` in the CLI's subcommand map.

## Usage

```
doco coverage                # working-tree only
doco coverage --since HEAD~5 # working-tree + last 5 commits
doco coverage --include-ignored  # also surface lockfiles, etc.
```

Exit 0 when clean, exit 1 when uncovered files exist (so CI can
treat it as a soft-fail signal).
