---
id: action_01KR6RSGG24BWEJXKV2HGMR7S9
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 9.4 — AGENT.md gets a 'How to ask the user something' section. Don't surface multiple-choice / radio-button questions to humans; default to decide-and-announce or open-ended ask. Generalizes the lessons from 9.2 + 9.3."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: codify_no_radio_button_questions

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6JHZYRQYJ3NBWV8RG7CRNR   # ADR-072 (AGENT.md as agent bootstrap)

inputs:
  user_direction: |
    "Let's teach the agents that when interacting with the user, they
    shouldn't be asking questions that are answered with radio buttons,
    as it is likely that the user will always have something else to say."
  prior_evidence:
    - "Phase 9.2 (action_01KR6P8RFXNA4AAX2P2X121JHF) — agent surfaced 'Where should the token live?' picker; user pushed back."
    - "Phase 9.3 (action_01KR6PHB5VH5WH9R1XFXTWMJCR) — agent surfaced 'Scaffold this repo?' picker; user pushed back again."
    - "Pattern was clear: agents default to multiple-choice. Time to encode the rule generally, not piecemeal."

outputs:
  source_files_changed:
    - AGENT.md   # NEW section 9: 'How to ask the user something'. Style notes renumbered 9 → 10.
  what_section_9_says:
    rule: "Don't ask multiple-choice / radio-button questions. Users almost always have something else to say that doesn't fit your options."
    pattern_a: "Decide and announce — when there's an obvious default, just do it and say what you did. Override stays available."
    pattern_b: "Ask open-ended — when you don't know, just ask in plain prose."
    bounded_pickers_ok: "Yes/no and human/agent are fine. Three+ canned options is almost always hiding a fifth option the user wanted."
    examples_anti_pattern:
      - "Where should I put the token? .env / shell rc / handle yourself?"
      - "Should I scaffold? Yes / Not yet / Type something"
    examples_good:
      - "Writing the token to .env (gitignored). Say if you want it elsewhere."
      - "About to scaffold the Doco. Anything I should know first?"

started_at: 2026-05-09T16:10:00Z
ended_at: 2026-05-09T16:13:00Z

created_at: 2026-05-09T16:13:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 9.4 — No radio-button questions

## The pattern

Three Actions in a row (9.2, 9.3, 9.4) have fixed the same shape of
bug: agents pop up multiple-choice questions to humans for things that
should either be decided or asked open-ended. AGENT.md now has a
named rule about it (section 9), so the next agent that's about to
surface a picker can read the line and pause.

## Why pickers fail

Three+ canned options force a discretization that's almost always
wrong:

- The user has a fifth option in mind.
- The user wants to give context that doesn't fit any option.
- The picker frames the conversation in the agent's terms, not the
  user's.

The replacement patterns:

- **Decide and announce** — for cases with an obvious default. The
  user can still override; you just don't make them pick.
- **Ask open-ended** — for cases where you genuinely don't know.
  Plain prose, no menu.

The exception (truly-bounded picks) covers human/agent and yes/no.
Anything beyond two options earns scrutiny.

## Generalization

This is the third encoding of "don't surface fake choices" but the
first one to name the rule explicitly. The named rule is the asset;
the prior Actions were data points.
