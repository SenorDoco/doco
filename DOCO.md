# Doco

This project is the meta-Doco — Doco's own Doco. Decisions, intents,
rules, and history about Doco-the-product live at:

**https://doco.to/meta-doco/**

(Internal ULID: `doco_01KR441EA0ZDMF0N5DY38GSVS3`. The handle
`meta-doco` is the public, human-readable URL id.)

## Browsing

Open https://doco.to/meta-doco/ and sign in with GitHub. If you
don't have access yet, ask any existing collaborator to mint an
invite for you from https://doco.to/meta-doco/invites.

## Agent protocol

`AGENTS.md` carries the contributor pointer. The full operating
contract (the four invariants) is at
https://doco.to/protocol/canonical-instructions.

Agents authenticate via OAuth 2.1 directly (no MCP). The recipe
covers both localhost-loopback (Recipe A, for shell-capable agents
like Claude Code) and Device Authorization Grant (Recipe B, for
chat-only agents), step by step at
https://doco.to/protocol/agent-oauth-recipe.
