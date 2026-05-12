---
id: action_01KR958AKGNFAR8BP22246018M
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: drift detection + capture-work nudges so Doco users (human + agent) don't ship work without recording it. Demonstrated firsthand this session."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: build_drift_detection_and_capture_nudges

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Notice what happened to you! You missed adding to doco important things.
    We need to address that proactively for users of doco, too. We don't
    want them miss that, too. Add working on this to the backlog."

  context: |
    During Phase 21 the agent shipped 6+ user-visible changes (inline scope
    edit, reparent/delete, LLM suggestions, /scopes/new reframing,
    .env auto-load, new isotype + wordmark, Phase 20 schema-fix) before
    a single Decision or Action was written. Only at the very end, when
    the user explicitly asked "what's missing from our own doco for a
    new agent to get enough context?" did the agent flush a Phase 21
    Action + ADR-085. Without that prompt the entire session's work
    would have been invisible to the next agent's bootstrap fetch.

    The drift mechanism is general:
    - Each individual change feels too small to write a Decision for.
    - The agent stays focused on the next user request, doesn't pause to capture.
    - There's no automated check that says "you've edited 6 source files since
      the last Action — write something."
    - Humans drift the same way: they know they "should" write an ADR but
      ship the change first and never get back to it.

    Doco's whole value proposition is that meaningful work leaves a trail.
    Without enforcement, the trail rots — silently, until a new agent or
    human picks up the codebase and can't reconstruct the why.

what_to_do:
  - >-
    Build a `doco coverage` CLI command that walks git's working tree (and
    optionally the last N commits) for modified files and cross-references
    them against every Action's `outputs.source_files_changed` field.
    Reports files modified but not referenced anywhere → "uncovered" set.
  - >-
    Surface `uncovered_changes` in `GET /api/v1/agent-bootstrap`. An agent
    starting work on a Doco-tracked repo immediately sees "the previous
    session left N files modified without a recording Action — investigate
    or capture before continuing."
  - >-
    Add periodic in-session reminders to the canonical agent instructions:
    "every ~5 meaningful tool uses or once per ~30 minutes of active work,
    pause and ask yourself: have I captured the last cluster of changes as
    an Action? If not, write one before the next user request."
  - >-
    Optional pre-commit hook (CLI: `doco install-hooks`) that refuses a
    commit when modified files exceed a threshold AND no Action ID is
    referenced in the commit message. Soft default — easy to skip with
    `--no-verify` for trivial commits.
  - >-
    `/coverage` web page that lists modified-but-uncovered files for a
    Doco. Click any to see "create an Action for these" prefilled with
    the file list.
  - >-
    Lint rule (`drift-uncovered-changes`) that runs in CI and fails if
    the working tree has uncovered changes after a commit. Same data as
    `doco coverage` surfaced as a first-class lint.

risks:
  - "False positives: trivial changes (typo fixes, version bumps) shouldn't require Actions. Need a sensible threshold or an ignore-list (e.g., pnpm-lock.yaml, *.tsbuildinfo)."
  - "False negatives: Action.outputs.source_files_changed is hand-written and could lie. The lint can only know what's *claimed*; it can't know what's omitted."
  - "Over-friction risk: if every change requires an Action, agents spend more time writing about their work than doing it. The thresholds + soft hooks need to lean toward 'helpful nudge' not 'blocking gate.'"

related:
  - "ADR-080 (centralized agent bootstrap) — uncovered_changes would land in the bootstrap response."
  - "ADR-075 (graph quality) — drift detection is the same shape as the orphan/connectivity lints, just at the file-coverage level instead of edge level."

follows:
  - action_01KR94Z93K39KH3894E4T63K80   # Phase 21 — the session that demonstrated the drift firsthand

decisions_consulted:
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (bootstrap response shape — would extend)

created_at: 2026-05-10T08:45:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: proposed
status: planned
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — drift detection + capture-work nudges

## Why

Doco's value is that meaningful work leaves a trail. The trail only
exists if someone — human or agent — actually writes the Action /
Decision when the work happens. Today nothing checks. Drift happens
silently.

The Phase 21 session is the proof case: the agent (me) shipped six
user-visible changes — inline scope edit/reparent/delete, LLM
suggestions, /scopes/new reframing, .env auto-load, new isotype +
wordmark, Phase 20 schema-rename followup — before writing a single
Action. Only when the user explicitly asked "what's missing from our
own doco?" did the capture happen. Without that prompt the next
agent's bootstrap fetch would have shown stale state and they'd have
had to reconstruct intent from `git log` and source files.

Same failure mode applies to humans. "I'll write the ADR next week"
becomes "I'll write it after this sprint" becomes never.

## What ships

A graduated set of nudges, lightest to strictest:

1. **`doco coverage`** — diagnostic CLI that lists files modified
   without a recording Action.
2. **Bootstrap-fetch surfacing** — `uncovered_changes: [...]` in the
   agent-bootstrap response so a fresh agent sees the drift on day one.
3. **Canonical instruction nudge** — agents are told to self-check
   periodically: "every ~5 meaningful tool uses, ask: have I recorded
   this as an Action?"
4. **Optional pre-commit hook** — soft refusal when uncovered changes
   exceed a threshold; bypassable.
5. **`/coverage` web page** — visual diff of modified vs covered files;
   one-click "create Action for these."
6. **Drift lint** — `pnpm doco lint` reports `drift-uncovered-changes`
   as a warning. Graduates to error in CI when the user opts in.

## What's out of scope

- AI-generated Action drafts. Tempting (LLM looks at git diff +
  proposes an Action body) but a separate Phase. Manual capture has
  to work first.
- Cross-Doco drift. A repo that imports another Doco might have drift
  in the imported one. Single-Doco coverage first; cross-Doco later.

## Trigger

When the user gives the go-ahead. Until then this stays in the
backlog. Likely a Phase 22 or later.
