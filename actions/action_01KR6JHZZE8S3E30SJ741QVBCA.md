---
id: action_01KR6JHZZE8S3E30SJ741QVBCA
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 9.1 — AGENT.md at repo root; success page stripped of technical recipes. Human's job is now: copy token, paste into chat. Agent reads repo's AGENT.md to learn what to do."

actor_id: claude-opus-4-7
verb: ship_agent_md_and_simplify_success_page

intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6JHZYRQYJ3NBWV8RG7CRNR   # ADR-072
  - decision_01KR6HJABS6GYHR9DXP4DZVRHR   # ADR-071 — predecessor

inputs:
  user_observation: |
    "Too complex. We need to provide all of these instructions for
    the agent I'm collaborating with so that this happens
    automatically as I interact with new agents on a given repo."
    Re: the /agents/new success page showing env-var export, curl
    health check, and spawn-sub-agent recipe to the human.

outputs:
  source_files_changed:
    - AGENT.md                                         # NEW — 8-section agent-bootstrap doc at repo root
    - CLAUDE.md                                        # NEW — one-line pointer to AGENT.md (Claude Code convention)
    - packages/web/app/routes/agents.new.tsx           # success page stripped: token + Copy + one-line "paste in your chat" + Principal id + back/create-another
    - decisions/decision_01KR6JHZYRQYJ3NBWV8RG7CRNR.md # ADR-072
    - packages/index/src/__tests__/build.test.ts       # decision/action counts
    - packages/core/src/__tests__/loader.test.ts       # decision lower-bound
  e2e_browser_verified:
    - "/agents/new success page now shows: token + Copy + one-line instruction. No bash recipes, no curl examples."
    - "AGENT.md exists at repo root with 8 sections: auth, host discovery, attribution, ancestry, humans-only, data model, when-in-doubt, style."
    - "CLAUDE.md exists as a one-liner pointing to AGENT.md."
  tests:
    full_workspace: "all 10 packages green"
    typecheck: "clean"
    lints: "4/4 clean"

started_at: 2026-05-09T14:30:00Z
ended_at: 2026-05-09T14:45:00Z

created_at: 2026-05-09T14:45:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 9.1 — AGENT.md + simplified success page

## The fix in one sentence

The human's loop is "copy token, paste in chat". The agent's loop is
"read the repo's AGENT.md". The success page no longer mixes those.

## Files

### `/AGENT.md` (new)

Eight sections, ~100 lines, written for an LLM with no prior context:

1. Authenticate before recording anything
2. Find the host URL
3. Attribute your work
4. Don't break the human-ancestry rule
5. Things only humans can do
6. Data model in 30 seconds
7. When in doubt
8. Style notes

The auth section explicitly tells the agent what to do when
DOCO_TOKEN is absent: ask the human, in plain prose, to visit
`/agents/new`. No curl recipes for the human.

### `/CLAUDE.md` (new)

One line. Points at AGENT.md. Lets Claude Code's default convention
find the framework instructions.

### `/packages/web/app/routes/agents.new.tsx`

Success page now shows:

- Title: "Agent created · {display_name}"
- Description: "Paste this token into your chat with the agent.
  They'll know what to do — their repo's AGENT.md tells them how to
  use it. We won't show it again."
- Token + Copy button
- Principal id (one-liner)
- "Back to your agents" / "Create another"

That's it. No `export DOCO_TOKEN=`, no curl test, no spawn recipe.

## Deferred to a future Action

Per ADR-072's last section: ship AGENT.md as part of the templates
that `doco init` and `doco host init` write. Today AGENT.md only
exists at the root of this self-hosted instance. New Docos created
via the CLI should get an AGENT.md out of the box. Easy ~30-line
follow-up: copy the file into `packages/cli/templates/`, wire into
the init helpers, add a CLI test.

Also deferred: the genuine "no human involvement" auth flow (OAuth
device-style or `doco auth` CLI command). ADR-072's alternative
section captured this as scoped-out from the current Decision.
