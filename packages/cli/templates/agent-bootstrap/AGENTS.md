# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project**. Doco coordinates this
project's intent, decisions, rules, actions, and logs. The Doco
URL(s) this repo connects to live in:

@./.doco/connections.md

## Getting access to this Doco (agent OAuth)

The MCP connector layer is removed for now — you drive OAuth
directly. Recipe lives at `https://doco.to/protocol/agent-oauth-recipe`.

  - **Shell-capable agents (Claude Code, Cursor, …)**: use Recipe A
    (localhost-loopback). Same shape as `gh auth login`. You'll
    open a browser tab, the project owner approves, you get a
    Bearer token.
  - **Chat-only / sandboxed agents**: use Recipe B (RFC 8628 Device
    Authorization Grant). You'll show the project owner a short
    code like `WXYZ-1234`, they approve at `https://doco.to/device`,
    you poll until you get a Bearer token.

Both end with `Authorization: Bearer doco_at_<token>` against the
Doco's HTTP API. If this Doco is public-visibility, anonymous reads
work without auth at all — try
`GET https://doco.to/<handle>/status.json`.

## Share this setup with other agents

Your OAuth token is private to you. The repo's Doco connection files
are not private; they are how another agent in another clone discovers
that this project uses Doco.

This applies even if you already have valid Doco auth. A working local
`DOCO_ACCESS` token does not mean the repository has the bootstrap files
future agents need. Before declaring Doco setup done, verify:

```sh
test -f .doco/connections.md
test -f AGENTS.md
test -f CLAUDE.md
```

If any are missing, add them. `CLAUDE.md` should be a one-line shim:

```md
@./AGENTS.md
```

After connecting a repo to Doco, commit and push the non-secret files
that were created or updated:

```sh
git status --short
git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude
git diff --cached --stat
git commit -m "Connect repository to Doco"
git push
```

Never commit `.env`, `DOCO_ACCESS`, refresh tokens, OAuth client state,
cookies, or any other credential. If the worktree contains unrelated
user changes, stage only the Doco bootstrap files you touched.

## Your role

- Get authenticated (recipe above) or browse anonymously if the
  Doco is public.
- Call out work that should be captured. When you make a Decision,
  fix a bug, or finish a load-bearing chunk of code, capture it
  directly if you're authenticated, or tell the project owner what
  to capture if you're not.
- Follow the four-invariant reply protocol at
  `https://doco.to/protocol/canonical-instructions` — query
  indicator at the top, footer lines after captures, capture-before-
  declaring-done discipline, tally line at the close.

## What lives where

- **`.doco/connections.md`** (committed, v15) — list of Doco URLs
  this repo connects to. Replaces the v12 `DOCO.md` (single URL);
  a repo can list multiple Docos with different per-OAuth-token
  access levels.
- **`AGENTS.md`** (this file, committed) — agent bootstrap pointer.
- **`CLAUDE.md`** (committed) — one-line shim `@./AGENTS.md`.
