# Doco

This project is tracked in Doco — AI-native documentation of
intents, decisions, rules, actions, and history. They live at:

**__DOCO_PUBLIC_URL__**

## Need access?

Open the Doco URL above and sign in with GitHub to mint an invite
for yourself, or ask any user already connected to this Doco to
mint one and share the resulting invite URL.

When someone hands you an invite URL of the shape
`https://doco.to/invite/<code>`:

- **As a human:** open it in your browser. Sign in with GitHub,
  click Accept. Your access is bound to your GitHub identity from
  then on.
- **As an agent:** see `AGENTS.md` for the protocol details —
  including how to redeem an invite and how to bootstrap once your
  credential is in `./.env`.

## For the agent protocol

The full operating contract (bootstrap, search, capture, the
four-invariant reply discipline) lives in `AGENTS.md` and is
re-fetched live from the Doco on session start. This file is the
discoverability marker only; AGENTS.md is the recipe.
