---
id: action_01KR6PHB5VH5WH9R1XFXTWMJCR
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 9.3 — AGENT.md teaches agents to surface the claim URL once, keep working, and remind every ~30 min. No 'should I scaffold?' or 'should I wait?' questions."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: tighten_agent_md_claim_workflow

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6JHZYRQYJ3NBWV8RG7CRNR   # ADR-072 (AGENT.md as bootstrap)
  - decision_01KR6KS73P659EVRVF73EW823F   # ADR-073 (onboarding wizard + claim ceremony)

inputs:
  user_observation: |
    Receiving agent popped a 3-option picker: "Scaffold this repo as
    Doco-tracked now? Not yet — claim first / Yes, scaffold / Type
    something." The user pushed back: "We should teach the agent to
    always prompt the user to claim it, but to be able to continue
    working on the Doco if the user ignores the claiming request.
    And every 30 minutes or so of interaction, remind the user to
    claim it."

outputs:
  source_files_changed:
    - AGENT.md   # new section 2 added; sections 3-9 renumbered
  what_section_2_says_now:
    - "Some onboarding paths hand you a claim_url alongside the token. That's how the human takes ownership."
    - "Don't ask. Don't pause. Just:"
    - "1. Tell the human ONCE in plain prose: 'I've started Doco for this project. Claim ownership when you can: <claim_url>'"
    - "2. Keep working. Unclaimed Docos accept entities normally."
    - "3. Every ~30 min of active interaction, remind once until they claim. Stop when owner_id stops being host-bootstrap."
    - "Don't surface 'should I scaffold?' or 'should I wait until claimed?' — both have one answer (yes / don't wait)."
  generalization:
    - "Same lesson as Phase 9.2 (don't-ask-where-to-store-token): when an agent's instruction has a single correct concrete action, write it as that action, not as a menu."

started_at: 2026-05-09T15:40:00Z
ended_at: 2026-05-09T15:43:00Z

created_at: 2026-05-09T15:43:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 9.3 — Claim URL: surface, work, remind

## What changed

AGENT.md gains section 2: "If you also got a claim URL: surface it,
keep working." Three concrete steps, ending with an explicit
prohibition on the two questions agents have been surfacing
(*"should I scaffold?"* and *"should I wait for claim?"*).

The ~30-minute reminder cadence is encoded as a guideline, with a
concrete stopping condition (the Doco's `owner_id` stops being
`host-bootstrap`).

## Generalization

This is the third Action in a row (Phase 9.2 = .env storage; this
one = claim cadence) that fixes the same shape of bug: AGENT.md
under-specified an action and the agent surfaced a fake choice to
the user. The pattern:

> When an agent's instruction has a single correct concrete action,
> write it as that action, not as a menu.

Worth a sweep over AGENT.md to find any remaining vague phrasing.
Probably a follow-up Action when the next vague phrasing surfaces in
the wild.

## What's still vague

The "every ~30 min" cadence is fuzzy because agents don't have a
reliable wall-clock interrupt. The agent can:

- Track turns since last reminder (rough proxy for time).
- Track timestamp of last reminder in `.env` or scratch state.
- Just remind opportunistically when the conversation pauses or the
  human asks a status question.

All three are acceptable. The instruction trusts the agent to pick
what works for their substrate.
