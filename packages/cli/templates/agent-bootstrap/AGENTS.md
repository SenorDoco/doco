# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project**. Doco coordinates this
project's intent, decisions, rules, actions, and logs. The Doco URL
for this project lives in:

@./DOCO.md

## Current state: human-led collaboration

Programmatic agent access (MCP connector) is being rebuilt and is
not available right now. For now, the **project owner** (a human)
is the primary contributor to the Doco: they navigate the web UI,
capture Decisions / Rules / Intents, and share what you need to
know with you in chat.

Your role:

- Browse the Doco (if public) for context — pages render at
  `https://doco.to/<doco-handle>/`.
- Call out work that should be captured. When you make a Decision,
  fix a bug, or finish a load-bearing chunk of code, tell the
  project owner: "this is worth capturing as a Decision / Rule /
  Log — want me to draft it for you?"
- Follow the four-invariant reply protocol at
  `https://doco.to/protocol/canonical-instructions` — query
  indicator at the top, footer lines after captures, capture-before-
  declaring-done discipline, tally line at the close.

## When MCP support returns

The plan is to re-introduce an MCP connector that runtimes install
per Doco. When that ships, you'll authenticate via OAuth in a
browser tab and get native Doco tools. The install URL will be
advertised in this file and at `https://doco.to/llms.txt`.

## What lives where

- **`DOCO.md`** (committed) — Doco URL.
- **`AGENTS.md`** (this file, committed) — agent bootstrap pointer.
- **`CLAUDE.md`** (committed) — one-line shim `@./AGENTS.md`.
