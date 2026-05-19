# Doco

This project is the meta-Doco — Doco's own Doco. Decisions, intents,
rules, and history about Doco-the-product live at:

**https://doco.to/meta-doco/**

(Internal ULID: `doco_01KR441EA0ZDMF0N5DY38GSVS3`. The handle
`meta-doco` is the public, human-readable URL id.)

## Connecting an agent

To use this Doco from any MCP-supporting runtime, install:

    https://doco.to/mcp/meta-doco

On first use, your runtime opens a browser tab to doco.to for one-
time OAuth approval. See `AGENTS.md` for per-runtime install
commands.

## Browsing as a human

Open https://doco.to/meta-doco/ and sign in with GitHub. If you
don't have access yet, ask any existing collaborator to mint an
invite for you from https://doco.to/meta-doco/invites.

## For the agent protocol

The full operating contract (the four invariants) is served as an
MCP resource at `doco://protocol/canonical-instructions` and
fetched on session start by the connected runtime. `AGENTS.md`
carries the install pointer.
