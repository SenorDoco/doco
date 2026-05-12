---
id: action_01KR6P8RFXNA4AAX2P2X121JHF
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 9.2 — AGENT.md tells agents to write the token to .env on their own. Removed the where-do-I-store-it question. Agents shouldn't surface storage choices that have one obvious answer."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: tighten_agent_md_token_storage_instructions

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6JHZYRQYJ3NBWV8RG7CRNR   # ADR-072 (AGENT.md as agent bootstrap)

inputs:
  user_observation: |
    A receiving agent, having got a token, popped a 4-option picker
    asking the human "Where should the DOCO_TOKEN live?" with options
    Write .env / Handle yourself / Add to ~/.zshrc / Type something.
    The user pushed back: "We should teach the agent as briefly as
    possible that they should add this to the .env on their own."

outputs:
  source_files_changed:
    - AGENT.md   # section 1 rewritten; explicit "do this — don't ask permission" with 3 numbered steps
  what_changed:
    before:
      - "Vague: 'set it in your environment for the rest of the session and proceed'"
      - "URL pointer: /agents/new (older path)"
    after:
      - "Explicit: append to ./.env, verify .gitignore covers it, use from .env"
      - "Numbered 3-step procedure"
      - "Final line: 'Don't surface a where-should-I-put-this question. The answer is always .env, gitignored. Asking wastes the user's time.'"
      - "URL pointer: just $host (homepage wizard, per Phase 10.2)"

started_at: 2026-05-09T15:35:00Z
ended_at: 2026-05-09T15:37:00Z

created_at: 2026-05-09T15:37:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 9.2 — Don't ask, just write to .env

The agent didn't know what to do with the token because AGENT.md told
it vaguely to "set it in your environment." So it asked the human a
multiple-choice question. Wrong loop.

The fix is one paragraph in AGENT.md. The token always goes in `.env`,
the file is always gitignored. There's no genuinely-multiple-options
question for the user to answer. AGENT.md now says so directly,
including the explicit "don't ask permission" line.

## Generalization

Any time AGENT.md (or comparable agent-instruction docs) describes
something with one obvious right answer, the instruction should be
imperative, not "the user might want X or Y." Surfacing fake choices
to the user wastes their attention. The lesson:

> When an agent's instruction has a single correct concrete action,
> write it as that action, not as a menu.
