---
id: action_01KR6NKCXAFX6803YKYXYFD6X5
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 10.2 — copyable share messages now point at the homepage URL only, not deep onboarding paths. The wizard self-routes any visitor; no pre-baked path needed in the link."

actor_id: claude-opus-4-7
verb: simplify_share_messages_to_homepage_only

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6KS73P659EVRVF73EW823F   # ADR-073 — onboarding wizard

inputs:
  user_direction: |
    "Let's make it work so that you only have to share the homepage,
    not an inside URL."
  prior_messages_too_specific: |
    The /onboarding/create/human page told the human to share a URL
    pointing at /onboarding/create/agent — a deep path that revealed
    implementation detail and was longer than necessary. Same on the
    join side. The wizard already routes any visitor based on intent
    + role, so the homepage URL is sufficient.

outputs:
  source_files_changed:
    - packages/web/app/routes/onboarding.create.human.tsx    # message → "Visit ${baseUrl} and follow the wizard."
    - packages/web/app/routes/onboarding.join.human.tsx      # message → "Visit ${baseUrl} and follow the wizard for joining an existing Doco."
    - packages/index/src/__tests__/build.test.ts             # bumped action count
  message_text_now:
    create: "We're starting to use Doco on this project. Visit ${baseUrl} and follow the wizard."
    join: "We're using Doco on this project. Visit ${baseUrl} and follow the wizard for joining an existing Doco."
  why_short_works:
    - "Homepage is the wizard root. Two cards (Join / Create) are clearly labeled."
    - "Each card's subtitle explains what it does."
    - "Next page asks Human/Agent — agent walks through it in 2-3 hops."
    - "The human's verb in the prose ('starting to use' vs 'using') is enough context for an LLM to pick the right card."

started_at: 2026-05-09T15:30:00Z
ended_at: 2026-05-09T15:32:00Z

created_at: 2026-05-09T15:32:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 10.2 — Share messages point at the homepage

The "tell your agent" copyable message used to include a deep
onboarding path (`/onboarding/create/agent`). Now it just points at
`/`. Two reasons:

1. **Shorter URL.** Easier to read in chat, easier to remember, less
   intimidating-looking.
2. **The wizard self-routes.** The homepage already has clearly
   labeled Join/Create cards and a role question on the next page.
   An agent (or human) walking in cold can navigate it in 2-3 clicks
   without any pre-baked URL hint.

The leaking implementation detail (the path `/onboarding/create/agent`)
is gone from the human-facing surface. If we restructure the wizard
later, share messages don't need to change.

## What stays

The role-split, the unclaimed-Doco flow, the claim ceremony — all
unchanged. Only the entry-URL changes.

## What this enables

A human can pin the homepage URL anywhere — chat history, notes, a
README — and the same URL works whether the receiver wants to join
or create, human or agent. One link to share, end of story.
