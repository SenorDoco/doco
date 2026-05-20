# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project** — and specifically, you are in
the meta-Doco: Doco's own Doco. Decisions about Doco the product
live in the Doco described in:

@./DOCO.md

## Getting access to this Doco (agent OAuth)

The MCP connector layer is removed for now — you drive OAuth
directly. Recipe at https://doco.to/protocol/agent-oauth-recipe.

  - **Shell-capable agents (Claude Code, Cursor, …)**: use Recipe A
    (localhost-loopback OAuth). Same shape as `gh auth login`. You
    open a browser tab, the project owner approves, you get a
    Bearer token.
  - **Chat-only / sandboxed agents**: use Recipe B (RFC 8628 Device
    Authorization Grant). You show the project owner a short code
    like `WXYZ-1234`, they approve at https://doco.to/device, you
    poll until you get a Bearer token.

Both recipes end with `Authorization: Bearer doco_at_<token>`
against `https://doco.to/meta-doco/api/*`.

## Your role

- Get authenticated (recipe above) or browse https://doco.to/meta-doco/
  for context if access is delayed.
- Call out work that should be captured. When you make a Decision,
  fix a bug, or finish a load-bearing chunk of code, capture it
  directly if you're authenticated, or tell the project owner what
  to capture if you're not.
- Follow the four-invariant reply protocol at
  https://doco.to/protocol/canonical-instructions — query indicator
  at the top, footer lines after captures, capture-before-declaring-
  done discipline, tally line at the close.

## What lives where

- **`DOCO.md`** (committed) — Doco URL.
- **`AGENTS.md`** (this file, committed) — agent bootstrap pointer.
- **`CLAUDE.md`** (committed) — one-line shim `@./AGENTS.md`.
