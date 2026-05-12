---
id: action_01KR7ABR84RPDAVHHNZ73MA2SG
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 18 — agent instructions moved to host (GET /api/v1/agent-bootstrap), AGENT.md collapsed to 12-line stub, scope setup as the explicit second step at /<owner>/<slug>/scopes/new. Per ADR-080."

actor_id: claude-opus-4-7
verb: centralize_agent_bootstrap

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080

follows:
  - decision_01KR7ABR811V3AQ8JG732A2DGK
  - action_01KR76H4DJP9C8CXEQWS6XWD83     # Phase 17 (scope-discoverability bundle — predecessor)

inputs:
  user_direction: |
    Initial ask:
    "Let's make sure that the instructions that we provide to the agent
    when creating a Doco properly explain the optimal way to use Doco...
    These instructions should be brief, simple, and abstract... they
    should not live in the repository or in the entity files. They should
    live in [Doco] so that we can always update the instructions that we
    are giving them."

    Two distinct asks:
    1. Centralize instructions: host-served, brief, abstract, think-don't-
       recipe (e.g. for BPMN, agent should research best practices and
       map to Doco primitives, not follow a baked-in recipe).
    2. Scope-prompt during onboarding: ask the human/agent what they want
       to document and seed Scope entities for those topics.

    Course-correction (rev 2):
    "Doco creation forms shouldn't ask for scopes upfront. It should be
    the second step after the creation of the Doco. It is a step
    required before users can start adding nodes to a Doco. After all,
    scopes can be added in the future, too."

    → Scope textarea moved off the create-Doco forms onto a dedicated
      /<owner>/<slug>/scopes/new page that's the explicit second step
      after creation, also reachable any time later to add more.

outputs:
  source_files_changed:
    api:
      - packages/api/src/instructions.ts             # NEW — canonical instructions as TS const
      - packages/api/src/server.ts                   # GET /api/v1/agent-bootstrap endpoint
    host:
      - packages/host/src/host.ts                    # createScopeInDoco(), parseScopeNamesInput(), subdirs (tags→scopes, +ideas)
      - packages/host/src/__tests__/host.test.ts     # parser + scope-creation tests
    schema:
      - schema/doco.schema.json                     # Scope.name regex now allows hyphens
      - packages/cli/templates/doco.schema.json     # synced from canonical (was stale: still had `tag`)
    web:
      - packages/web/app/lib/redeem.server.ts                            # re-export createScopeInDoco + parseScopeNamesInput
      - packages/web/app/routes/new-doco.tsx                            # NO scopes; redirect to /<owner>/<slug>/scopes/new?onboarding=1
      - packages/web/app/routes/onboarding.create.agent.tsx              # NO scopes; success page shows "Set up scopes →" link
      - packages/web/app/routes/$ownerSlug.$docoSlug.scopes.new.tsx     # NEW — second-step scope setup page
    repo:
      - AGENT.md                                                         # 192 → 12 lines (stub pointing at bootstrap endpoint)

  endpoints_added:
    - "GET /api/v1/agent-bootstrap (single-Doco) returns: canonical_instructions, doco, counts, scopes (sorted by member_count), known_issues (lint summary), recent_activity (last 10 entities)"

  helpers_added:
    - "createScopeInDoco({ docoDir, docoId, name, description?, createdBy }) → EntityId<scope>"
    - "parseScopeNamesInput(text) → { valid: string[], invalid: string[] } — newline-separated, dedupes, validates against schema regex"

  ui_changed:
    - "/new-doco: scope textarea removed; redirects to /<owner>/<slug>/scopes/new?onboarding=1 on success"
    - "/onboarding/create/agent: scope textarea removed; success page gains 'Set up scopes →' card linking to the same route"
    - "/<owner>/<slug>/scopes/new: NEW page — multi-line scope input, shows existing scopes inline, has 'Skip for now' button when ?onboarding=1, otherwise reachable any time to add more"
    - "Validation surfaces invalid scope names back to the user (no silent drops)"

  schema_changed:
    - "Scope.name regex: ^[a-z][a-z0-9_]*(/[a-z][a-z0-9_]*)*$ → ^[a-z][a-z0-9_-]*(/[a-z][a-z0-9_-]*)*$ (hyphens allowed; matches ADR-079's user-flow/checkout examples)"
    - "Per-Doco subdir list: rename tags→scopes, add ideas (was a stale leftover from before ADR-074 + ADR-078)"

  tests_added:
    - "@doco/host: parseScopeNamesInput happy path (valid hierarchical names with hyphens/underscores/digits)"
    - "@doco/host: parseScopeNamesInput rejects bad names + dedupes within input"
    - "@doco/host: parseScopeNamesInput skips blank lines and comments"
    - "@doco/host: createScopeInDoco writes a yaml the indexer can pick up"
    - "@doco/host: createScopeInDoco attributes created_by when supplied"

  e2e_verified:
    - "GET /api/v1/agent-bootstrap returns all 6 fields populated against the meta-Doco (scopes ordered by member_count desc, known_issues with 8 connectivity warnings, 10 recent_activity entries, 3.9KB canonical_instructions)"
    - "/onboarding/create/agent (rev 2): submit with no scope textarea → success page shows DOCO_TOKEN + claim message + 'Set up scopes →' link"
    - "/<owner>/<slug>/scopes/new?onboarding=1 accepts hierarchical scope names with hyphens, slashes; existing scopes list updates after submit; Skip for now button redirects to Doco home"

  test_status: |
    pnpm -r test → all 10 packages green:
      shared 0, core 5, cli 1, index 5, runtime 7, lints 9,
      discovery 3, api 12, host 15 (+5 new), web 0
    Web tests run via Chrome E2E (verified above).
    Builds: pnpm -r build → green across all packages.

constraints_observed:
  - "Brief + abstract instructions: 3.9 KB markdown. No methodology recipes."
  - "AGENT.md stub stays under 15 lines."
  - "Single endpoint covers all bootstrap concerns (no separate /instructions + /context split)."
  - "Schema-name regex stays AJV-compatible; uses character class for hyphens."
  - "Scope creation runs before the first reindex so the agent's first bootstrap fetch sees them."

decisions_consulted:
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (this Phase's ADR)
  - decision_01KR76H4DAJ1ZR26ZTD69CQD8H   # ADR-079 (scope-driven discoverability — bootstrap exposes scopes)
  - decision_01KR74PX31DH2Q70B6JFV8PQ14   # ADR-078 (tag → scope rename)

started_at: 2026-05-09T21:35:00Z
ended_at: 2026-05-09T21:50:00Z

created_at: 2026-05-09T21:50:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 18 — centralize agent bootstrap

## What

`AGENT.md` had grown to ~200 lines covering a dozen concerns. Two
problems: (1) updating it meant walking every repo, and (2) it could
never reflect this Doco's actual current state — its scopes, lint
backlog, recent activity.

Per ADR-080, this Phase moves the substantive instructions to the host
and exposes a single bootstrap endpoint that bundles them with the
per-Doco context an agent needs to start working.

## Verification

```
$ curl -s http://127.0.0.1:8787/api/v1/agent-bootstrap | jq 'keys'
[ "canonical_instructions", "counts", "doco", "known_issues",
  "recent_activity", "scopes" ]

$ curl -s … | jq '.scopes | length'
6

$ curl -s … | jq '.recent_activity | length'
10

$ curl -s … | jq '.canonical_instructions | length'
3971
```

End-to-end Chrome verification of `/onboarding/create/agent`:

```
$ ls /tmp/doco-test-host/docos/host-bootstrap/phase18-test-doco/scopes/
scope_01KR7BA4YP26ZJB4XNE262A7X0.yaml   # user-flow/checkout
scope_01KR7BA4YQ5TPDYGC60WTKSHQZ.yaml   # reporter/board
scope_01KR7BA4YQ815FX9YVWGF44QTT.yaml   # design-system/components
scope_01KR7BA4YQ9BBR7RZ97NP0PG27.yaml   # country/france/payment
```

All four hierarchical scope names (including hyphenated `user-flow`
and `design-system`) created as `Scope` entities in the new Doco, ready
for the first bootstrap fetch.

## Why this is the cheap win it claims to be

- **Centralized updates.** Conventions change with every ADR. Agents
  pick up the new copy on the next session, not on the next repo PR.
- **Per-Doco context.** Static `AGENT.md` can't tell the agent that
  this Doco has 8 connectivity warnings or that the active scopes
  are `country/*` and `user-flow/*`. The bootstrap can.
- **No methodology recipes.** Agents are told to research the
  canonical practice (BPMN, ADR-style, runbook conventions) and
  map to Doco's twelve primitives. Forces thinking; survives
  methodology shifts that any baked-in recipe wouldn't.
- **Seeded scopes at create-time.** Empty scopes = "invent every
  name as you go." Seeded scopes = "here's the structure the human
  cares about; assign new nodes to these."
