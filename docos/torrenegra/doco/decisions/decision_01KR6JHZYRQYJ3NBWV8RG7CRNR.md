---
id: decision_01KR6JHZYRQYJ3NBWV8RG7CRNR
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "AGENT.md at the repo root is the agent's bootstrap instructions. Per-repo, not per-token. The /agents/new success page stops dumping technical recipes on the human; the agent reads them from the repo instead."

slug: agent-md-as-repo-bootstrap
number: "ADR-072"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "ADR-071 simplified provisioning to a single click on /agents/new. The success page still showed the human three pages of technical recipe (env var export, curl test, spawn-sub-agent curl). The user pushed back: 'Too complex. We need to provide all of these instructions for the agent I'm collaborating with so that this happens automatically.' Where should those technical instructions live?"
chosen: |
  Two changes, working as a pair:

  1. **`AGENT.md` at the repo root** is the agent's bootstrap context.
     A fresh agent walking into an Doco-tracked repo (no prior chat
     context) reads this file to learn:

     - what kind of project this is
     - how to find the host URL
     - how to authenticate (look for DOCO_TOKEN; if absent, *ask the
       human in plain prose* — no curl recipes for the human to follow)
     - how to attribute work as Action / Reasoning entities
     - the human-ancestry invariant and which actions are humans-only
     - where to look when in doubt (Decisions, Rules, lints)

     Plus a one-line `CLAUDE.md` that points at it, so Claude Code's
     default convention finds it.

  2. **The `/agents/new` success page strips the technical recipes**.
     Now it shows: token + Copy button + one-line instruction
     ("Paste this into your chat with the agent. They'll know what to
     do — their repo's AGENT.md tells them how to use it."). Principal
     id underneath. Two buttons: back / create another. That's all.

  The split is: *human-facing* surface stays minimal (copy a token, paste
  it). *Agent-facing* surface (technical recipes, schema details, host
  URL resolution rules) lives in AGENT.md where the agent will actually
  read it.

  This addresses the user's complaint by recognizing that the audience
  for "export DOCO_TOKEN=..." instructions is the agent, not the human.
  Telling the human to teach the agent the technical setup is the wrong
  loop — the repo can teach the agent directly.
alternatives:
  - name: Keep the technical recipe on the success page; trust the human to relay it
    rejected_because: "That's the current state and the user explicitly rejected it. Asks the human to do work the agent should be doing."
  - name: Embed AGENT.md content as a hidden HTML comment in the token response, so any agent reading the chat gets it
    rejected_because: "The agent might not be in the same chat as the token paste. Better to put the instructions in the repo where the agent will look anyway when starting work."
  - name: Build an `doco auth` CLI command that handles the whole flow
    rejected_because: "Worth doing, but bigger-scope than this Decision. Captured separately as a follow-up Action. AGENT.md ships alone in this Decision; CLI flow can layer on top."
  - name: Bake instructions into a hard-coded system prompt for Claude
    rejected_because: "Doesn't scale across agents (other LLMs, other tools). Repo-level AGENT.md is universal — any agent can read it; no provider buy-in needed."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-09T14:40:00Z

created_at: 2026-05-09T14:40:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-072 — AGENT.md as the repo's agent-bootstrap file

## What changed

| Before | After |
|---|---|
| Success page dumped `export DOCO_TOKEN=...; curl ...; curl spawn ...` on the human | Success page: token + Copy + one line ("paste this in your chat") |
| Agent walking into a fresh repo had no idea what kind of project it was or how to authenticate | Agent reads `AGENT.md` at the repo root and learns |

`AGENT.md` is roughly 100 lines, structured into 8 sections (auth, host
discovery, attribution, ancestry, humans-only actions, data model,
where-to-look-when-stuck, style notes). It's written for an LLM
walking in cold — minimum prose, maximum decisive instructions.

`CLAUDE.md` is a one-liner pointing at AGENT.md, since Claude Code reads
CLAUDE.md by convention. Future tools that adopt similar conventions
(GEMINI.md, GPT.md, …) can do the same — AGENT.md remains the canonical
file.

## Generalization

The repo is the right place for agent-bootstrap context because:

1. The agent is *already in the repo* when it starts working. It
   doesn't need a network round trip or a token to read a local file.
2. The instructions can vary per-repo without requiring central
   configuration. Different Docos can have different conventions
   (model preferences, branch naming, lint levels) — AGENT.md captures
   them at the right scope.
3. It doesn't lock to a vendor. Any LLM / any agent / any tool that
   reads filesystem context picks it up.
4. It composes with the user's own preferences — humans can append
   their own "always do X in this repo" notes.

## Future work the user flagged

The full vision was *"this happens automatically as I interact with new
agents on a given repo"*. AGENT.md is half. The other half is the
agent-side automation — when an agent reads AGENT.md and finds no
DOCO_TOKEN, it asks the human in clear prose. That's a behavioral
expectation for the agent, encoded in the AGENT.md text itself, not a
code change in this repo.

A genuinely automated flow (no human involvement at all) would need
either OAuth-style device flow (browser, code, callback) or a CLI
command like `doco auth` that opens a browser to `/agents/new` and
captures the resulting token via callback. That's a separate Action
to scope and ship.

## When this lands for new Docos

Today AGENT.md exists at the root of *this* Doco (the framework's own
self-hosting instance). A follow-up Action should add AGENT.md to the
templates that `doco init` and `doco host init` write, so every new
Doco ships with one out of the box. Captured as deferred work in the
companion Action to this Decision.
