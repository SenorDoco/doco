# Doco

This project is tracked in Doco — AI-native documentation of
intents, decisions, rules, actions, and history. The Doco lives at:

**__DOCO_PUBLIC_URL__**

## Connecting an agent

To use Doco from any agent runtime, install the MCP connector at
the URL above (with `/mcp/<handle>` appended) — see `AGENTS.md`
for per-runtime install commands. On first use, your runtime opens
a browser tab to doco.to for one-time OAuth approval. No files to
edit, no env vars to set.

## Browsing as a human

Open the Doco URL above and sign in with GitHub. If the Doco is
private and you don't have access yet, ask anyone already
connected to mint an invite for you from the Doco's Invites page.

## For the agent protocol

`AGENTS.md` carries the install pointer. The full operating
contract (the four invariants) is served as an MCP resource at
`doco://protocol/canonical-instructions` and fetched on session
start by the connected runtime.
