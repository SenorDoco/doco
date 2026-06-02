# Doco

This project is tracked in Doco - AI-native documentation of
intents, decisions, rules, actions, and history. The Doco lives at:

**https://doco.to/torre-bpms/**

## Browsing

Open the Doco URL above and sign in. If the Doco is private and you
do not have access yet, ask anyone already connected to mint an invite
for you from the Doco's Invites page.

## Agent Protocol

Agents authenticate via OAuth 2.1 directly. Recipe for both
localhost-loopback (shell-capable agents) and Device Authorization
Grant (chat-only / sandboxed agents) at
`https://doco.to/protocol/agent-oauth-recipe`.

## Sharing This Connection

This file is the committed, non-secret project coordinate. After an
agent creates or updates it, that agent should commit and push it
alongside `AGENTS.md`, `CLAUDE.md`, `.agents/doco-agent-client.mjs`,
and `.claude/` hook files if those changed.

Never commit `.env`, `DOCO_ACCESS`, refresh tokens, OAuth client
state, cookies, or any other credential. Those stay local or in the
agent runtime's secret store.
