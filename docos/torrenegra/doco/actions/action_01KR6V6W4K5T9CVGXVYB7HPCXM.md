---
id: action_01KR6V6W4K5T9CVGXVYB7HPCXM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 13 — graph quality. Connectivity lint (warns Decisions/Actions/Rules/Ideas/Intents that lack context), 'Referenced by' card on every entity page, and POST /api/v1/suggest for FTS-based write-time discovery."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: ship_graph_quality_layers

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6V6W4HMM5CBJV22FD0HFSP   # ADR-075

inputs:
  user_concern: |
    "In large docos, for any node to make sense, it relies on the
    context. The context comes, in part, from the edges. What can we
    do to make sure that nodes are properly interconnected with nodes
    that are relevant to them, that are in the same area of the
    project and end up not being isolated and missed out by mistake
    when performing searches and updates?"
  user_choice: "A + C + D from the brainstorm of five strategies"

outputs:
  source_files_changed:
    - packages/lints/src/connectivity.ts                                   # NEW — ~80 lines, per-type minimum-edge rules
    - packages/lints/src/index.ts                                          # registered new lint in SYSTEM_LINTS
    - packages/web/app/routes/e.$type.$id.tsx                              # 'Referenced by (N)' card always rendered, even at N=0
    - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type.$id.tsx        # same change for host-mode
    - packages/api/src/server.ts                                           # POST /api/v1/suggest + ftsSanitize helper
    - AGENT.md                                                             # §4: 'Before you write, find related work — call /api/v1/suggest'
    - decisions/decision_01KR6V6W4HMM5CBJV22FD0HFSP.md                     # ADR-075
    - packages/index/src/__tests__/build.test.ts                           # bumped action count
    - packages/core/src/__tests__/loader.test.ts                           # bumped decision lower-bound
  e2e_verified:
    - "pnpm doco lint runs the connectivity check; flagged 8 Rules with empty applies_to (warnings, not errors)"
    - "POST /api/v1/suggest with summary 'agent invitation token' returned 5 hits — ADR-068, action_01KR6DKHCJCFBG2P6ZRCYRS74E (Phase 8), ADR-069, ADR-035, action_01KR6FYFQQEGMKP33Z695QNE8Q — exactly the right cluster"
    - "Entity-detail pages show 'Referenced by (N)' even at N=0 (verified via inspection of the route component)"
  what_the_lint_caught:
    - "8 Rules with no applies_to.tags AND no applies_to.types. These are early Rules from the bootstrap; legit signal that they need backfilling. Captured as a backlog item — not in this Action's scope."
    - "0 Decisions, Actions, Ideas, or Intents flagged in the current meta-Doco state."

started_at: 2026-05-09T17:00:00Z
ended_at: 2026-05-09T17:15:00Z

created_at: 2026-05-09T17:15:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 13 — Three layers of graph quality

## What ships

| Layer | When it runs | What it does |
|---|---|---|
| **Connectivity lint (A)** | `pnpm doco lint` | Warns when an entity has no outbound edges to its required-type targets, or no scope tags |
| **'Referenced by' card (C)** | Every entity-detail page render | Shows `(N)` of incoming edges, always — N=0 is a deliberate visual signal of isolation |
| **`/api/v1/suggest` (D)** | Pre-write, called by the agent | Returns FTS5-ranked existing entities matching a draft summary/body |

Each one targets a different failure mode of graph isolation:

- A stops *new* entities from landing without context.
- C makes *existing* isolation visible at a glance.
- D lowers the cost of doing the right thing at write-time.

## Live test

```
$ curl -X POST -d '{"summary":"agent invitation token","limit":5}' \
       http://127.0.0.1:8787/api/v1/suggest
```

Returns:
1. ADR-068 — Invitation flow implementation
2. action_01KR6DKHCJCFBG2P6ZRCYRS74E — Phase 8 agent-invitation flow
3. ADR-069 — Agent-side invitation page
4. ADR-035 — Agents cannot self-create accounts
5. action_01KR6FYFQQEGMKP33Z695QNE8Q — Phase 8.1

Exactly the right cluster — an agent writing a new invitation-flow
entity would link these and avoid orphaning their work.

## What the lint surfaced

Eight Rules with empty `applies_to`. These are bootstrap-era Rules
that defined a constraint without specifying its scope. Real signal
to backfill, captured as an implicit follow-up — when those Rules
get touched next, set their `applies_to`.

The fact that no Decisions, Actions, Ideas, or Intents were flagged
means the meta-Doco's content layer is in good shape. The connectivity
problem currently exists only in the Rule definitions — and even those
are advisory warnings.

## Why warning, not error

The lint defaults to `severity: warning`. Tightening to `error` would
fail validation on the 8 existing flagged Rules until they're
backfilled. Per ADR-075, graduate to error only after the corpus is
clean. Until then, the warning surfaces the issue without breaking
the validate cycle.
