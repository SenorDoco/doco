---
id: decision_01KR7ABR811V3AQ8JG732A2DGK
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Agent instructions live on the host (not in the repo) and are fetched fresh at session start, alongside per-Doco context. Repo carries only a thin AGENT.md stub."

slug: centralized-agent-bootstrap
number: "ADR-080"
follows:
  - decision_01KR76H4DAJ1ZR26ZTD69CQD8H   # ADR-079 (scope-driven discoverability — bootstrap surfaces scopes)
  - decision_01KR74PX31DH2Q70B6JFV8PQ14   # ADR-078 (tag → scope rename — bootstrap docs the new term)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "AGENT.md in each repo holds 200+ lines of instructions. Updating them means walking every repo. Worse: the instructions don't reflect this Doco's actual current state — its scopes, lint backlog, recent activity. How should an agent get its onboarding context?"
chosen: |
  Move the substantive instructions to the host. Each agent fetches them
  fresh at session start, in the same response that carries this Doco's
  scopes, lint summary, and recent activity. Repos keep a tiny stub.

  ### Endpoint

  `GET /api/v1/agent-bootstrap` — single-Doco mode. Returns:

  ```jsonc
  {
    "canonical_instructions": "<markdown>",
    "doco": { "doco_id", "slug", "display_name", "description",
              "mode", "host_url" },
    "counts": { "decision": 79, "action": 43, ... },
    "scopes": [
      { "id", "name", "summary", "member_count" },
      ...   // ordered by member_count desc, name asc
    ],
    "known_issues": [
      { "lintId", "warnings", "errors", "sample" },
      ...
    ],
    "recent_activity": [
      { "id", "node_type", "summary", "created_at" },
      ...   // last 10 entities across content types
    ]
  }
  ```

  Single endpoint. One round-trip to learn:
  - what to do (canonical_instructions),
  - what this Doco is about (doco + scopes),
  - what's already broken (known_issues),
  - what's been happening (recent_activity).

  ### Canonical instructions: brief, abstract, think-don't-recipe

  The instructions live as a TS const in `@doco/api/src/instructions.ts`.
  Editing it updates every running agent on its next bootstrap fetch.

  Three principles drove the rewrite:

  1. **Brief.** ~3.5 KB markdown vs. AGENT.md's old 7+ KB. Anything an
     agent can derive from the schema, the suggest endpoint, or a
     sibling entity is *not* repeated here.
  2. **Abstract.** No methodology recipes. For BPMN-style flows,
     design-system docs, post-mortems, customer playbooks, the
     instructions tell the agent: research the canonical practice,
     decompose into nouns + verbs, map nouns to node types and verbs
     to edges, and use scopes to group. Doco gives twelve primitives;
     the agent decides how to compose them.
  3. **Think-first.** The instructions explicitly call out the
     "if you find yourself wanting a node type that doesn't exist,
     you're trying to encode a verb — use an edge or a scope" pattern.
     Agents that read this stop asking for new node types.

  ### Repo stub

  `AGENT.md` collapses from 192 lines to 12. The body:

  > You're in a Doco-tracked project. Your real instructions are
  > served by the host. Fetch `GET $DOCO_HOST/api/v1/agent-bootstrap`
  > and read `canonical_instructions` before you start.

  That's it. Updates to conventions never require a repo PR.

  ### Scope setup as the explicit second step (rev 2)

  Initial design (rev 1) put a scope textarea on the create-Doco
  forms themselves. Course-corrected: the create-Doco forms now
  collect Doco metadata only. **Scope setup is the explicit second
  step** at `/<owner>/<slug>/scopes/new?onboarding=1`, reached
  immediately after creation:

  - Submitting `/new-doco` redirects there.
  - The agent-create success page links there with a "Set up scopes →"
    button alongside the DOCO_TOKEN + claim message.
  - The same page (without `?onboarding=1`) is reachable any time to
    add more scopes.

  The scope-add form takes one name per line, validates against
  `^[a-z][a-z0-9_-]*(/[a-z][a-z0-9_-]*)*$` (the schema regex was
  extended to allow hyphens — ADR-079's examples used
  `user-flow/checkout` but the regex didn't actually accept it),
  and shows existing scopes inline so users don't double-create.

  Why second-step, not first-step? Three reasons:
  1. **Doco creation is one decision; scope setup is many.** Bundling
     them into one form makes the form long for users who have a
     clear scope plan, and pressure-y for users who don't.
  2. **Scopes can be added later.** Treating them as part of creation
     implies a one-shot decision; treating them as their own step
     reflects the reality that scopes evolve.
  3. **The same page is reusable.** `/<owner>/<slug>/scopes/new`
     handles both first-time setup (with onboarding banner + skip
     option) and later additions (no banner, no skip). One route,
     two contexts.

  Why a step at all (rather than "add scope at any time, no
  ceremony")? Because empty-scopes is a known bad state — the
  connectivity lint complains about every node, and the agent
  bootstrap ships with no `scopes` to assign to. Surfacing this
  immediately after creation makes the right thing easy.

  ### Why this earns its keep

  - **Centralized updates.** Conventions change with every ADR; agents
    pick up the new copy on the next session, not on the next repo PR.
  - **Per-Doco context.** Static AGENT.md can't tell the agent that
    this Doco has 8 connectivity warnings, or that the active scopes
    are `country/*` and `user-flow/*`. The bootstrap endpoint can.
  - **Single source of truth.** The same response the agent reads is
    a clean target for evaluation, replay, and debugging.

alternatives:
  - name: Keep AGENT.md as the source of truth; agents read it from disk
    rejected_because: "Stale by definition. Updating it means walking every repo. Misses per-Doco state entirely (lint warnings, scopes, recent work). The user's reason for moving away from this is exactly that."
  - name: Two endpoints — /api/v1/instructions for the static doc, /api/v1/context for per-Doco state
    rejected_because: "More round-trips, more chances to fail half-way. The bootstrap is one logical operation: 'tell me how to work here.' One endpoint is the right granularity."
  - name: Embed BPMN / design-system / runbook recipes into the instructions
    rejected_because: "Treats the agent as a recipe-follower instead of a thinker. The user's framing was explicit: encourage agents to research best practices and map to Doco's primitives, not hand them a Doco-specific recipe for every methodology. Recipes also bit-rot fastest."
  - name: Per-Doco bootstrap endpoint in host mode at /api/v1/<owner>/<doco>/agent-bootstrap
    rejected_because: "Useful but not yet — host-mode reads route through the web's per-Doco loaders today. Captured by the cleanup-sweep Action; ship single-Doco bootstrap first since it covers the meta-Doco and every fresh `doco init`."
  - name: Scope textarea on the create-Doco forms (rev 1's approach)
    rejected_because: "Bundles two unrelated decisions (Doco metadata + scope plan) into one form. Pressures the user to commit to a scope hierarchy before they've even seen the new Doco. The second-step page treats scope setup as the ongoing concern it actually is."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: torrenegra
decided_at: 2026-05-09T21:46:00Z

created_at: 2026-05-09T21:46:00Z
created_by: claude-opus-4-7
revision: 2
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-080 — Centralized agent bootstrap

## Why now

`AGENT.md` had grown to ~200 lines covering authentication, attribution,
the data model, the human-ancestry rule, the suggest endpoint, the
question-asking style, and a dozen other things. Two problems:

1. **Updating it means walking every repo.** Conventions change every
   ADR; the repo file rots between updates.
2. **It can't reflect per-Doco state.** Static text can't say "this
   Doco has 8 connectivity warnings" or "the active scopes are
   `country/*` and `user-flow/*`." Agents read AGENT.md once, then
   try to figure out the rest from sibling entities.

The user's framing was the trigger:

> These instructions should be brief, simple, and abstract... they
> should not live in the repository or in the entity files. They
> should live in [Doco] so that we can always update the
> instructions that we are giving them.

## What ships

| # | Move | Where |
|---|---|---|
| 1 | `GET /api/v1/agent-bootstrap` returning canonical_instructions + per-Doco context | `packages/api/src/server.ts` |
| 2 | Canonical instructions as a TS const — brief, abstract, think-don't-recipe | `packages/api/src/instructions.ts` |
| 3 | `AGENT.md` collapsed to a 12-line stub pointing at the endpoint | `AGENT.md` |
| 4 | Scope setup as the **second step**: new route `/<owner>/<slug>/scopes/new` (with `?onboarding=1` for first-time banner + Skip), reachable from `/new-doco` redirect and the agent-create success page | `routes/$ownerSlug.$docoSlug.scopes.new.tsx` |
| 5 | `createScopeInDoco()` + `parseScopeNamesInput()` helpers in `@doco/host` | `packages/host/src/host.ts` |
| 6 | Scope-name regex extended to allow hyphens (`user-flow/checkout` now validates) | `schema/doco.schema.json` |
| 7 | New-Doco subdir list: rename `tags` → `scopes`, add `ideas` | `packages/host/src/host.ts` |

## What's deferred

- Host-mode per-Doco bootstrap (`/api/v1/<owner>/<doco>/agent-bootstrap`)
  isn't wired yet. Single-Doco mode covers the meta-Doco and every
  `doco init`. Captured by the cleanup-sweep Action.
- A bootstrap content-hash header (`ETag`) so agents can skip the
  re-fetch when nothing changed. Premature; the response is small
  and the per-Doco context changes constantly anyway.
- LLM-summarized "what's been happening lately" instead of the raw
  `recent_activity` list. The list is fine for now; summarization
  is a UX nicety.
