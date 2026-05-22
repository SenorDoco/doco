# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project**. Doco coordinates this
project's intent, decisions, rules, actions, and logs. The Doco
URL(s) this repo connects to live in:

@./.doco/connections.md

Everything below is **binding instructions you execute now, in
order**, not background reading. If you skip them, your reply will
violate the protocol.

## Step 1 — Fetch the reply protocol

```
GET https://doco.to/protocol/canonical-instructions
```

This doc carries the **four invariants every reply must follow** —
the literal indicator strings, verb lists, capture rules, tally
format. It is the source of truth for how you reply; do not infer
it from memory. Fetch it before your first substantive reply, and
apply it on every reply for the rest of the session.

**Do not infer the protocol from this file's mentions of it.** This
file describes WHAT the protocol enforces; the canonical URL holds
the LITERAL strings (specific emoji, verb lists, exact format).
Reinventing a tally or indicator from inference — e.g., "Tally: 0
captures this turn" instead of `[🔮 Doco] <handle>: **<N>** node(s)
added/updated` — is non-compliant. Fetch the URL.

## Step 2 — Check Doco access

```
GET https://doco.to/<handle>/status.json
```

- **200** → the Doco is public. Read freely (lists, nodes,
  constitution) without auth. You still need OAuth to **capture**.
- **401 / 403** → the Doco is private. Run the OAuth recipe at
  `https://doco.to/protocol/agent-oauth-recipe` before answering
  any Doco-relevant question.

OAuth recipes:

  - **Shell-capable agents (Claude Code, Cursor, Codex CLI, …)**:
    Recipe A (localhost-loopback). Same shape as `gh auth login`.
  - **Chat-only / sandboxed agents**: Recipe B (RFC 8628 Device
    Authorization Grant). Show the project owner a short
    `WXYZ-1234` code, they approve at `https://doco.to/device`,
    poll until you get the token.

Both end with `Authorization: Bearer doco_at_<token>` on every API
call.

## Step 3 — Read the Articles of the Constitution

```
GET https://doco.to/api/v1/agent-bootstrap.json
Authorization: Bearer doco_at_<token>     # only if private
```

Fetch once per session and re-fetch if you suspect the constitution
changed mid-session. The canonical doc explains how to treat
`guidance_articles[]` and `node_authoring_articles[]`.

## How agents fail at the bootstrap

- **Treating this file as background context.** It's instructions
  to execute. If you finish reading it and answer a Doco-relevant
  question without rendering the connection indicator at the top
  and the tally at the bottom, you skipped Step 1.
- **Skipping the canonical-instructions fetch because "it's just a
  reply protocol."** Without it you won't know the literal
  `[🔮 Doco]` strings, the verb lists, or the tally rules.
- **Skipping anonymous browse because OAuth feels heavy.** Try
  `status.json` first — many Docos let you read freely.

## Share this setup with other agents

Your OAuth token is private to you. The repo's Doco connection
files are not private; they are how another agent in another clone
discovers that this project uses Doco.

Even with valid local auth, a working `DOCO_ACCESS` token does not
mean the repository has the bootstrap files future agents need.
Before declaring Doco setup done, verify:

```sh
test -f .doco/connections.md
test -f AGENTS.md
test -f CLAUDE.md
```

If any are missing, add them. `CLAUDE.md` should be a one-line
shim:

```md
@./AGENTS.md
```

After connecting a repo to Doco, commit and push the non-secret
files that were created or updated:

```sh
git status --short
git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude
git diff --cached --stat
git commit -m "Connect repository to Doco"
git push
```

Never commit `.env`, `DOCO_ACCESS`, refresh tokens, OAuth client
state, cookies, or any other credential. If the worktree contains
unrelated user changes, stage only the Doco bootstrap files you
touched.

## What lives where

- **`.doco/connections.md`** (committed, v15) — list of Doco URLs
  this repo connects to. Replaces the v12 `DOCO.md` (single URL);
  a repo can list multiple Docos with different per-OAuth-token
  access levels.
- **`AGENTS.md`** (this file, committed) — agent bootstrap pointer.
- **`CLAUDE.md`** (committed) — one-line shim `@./AGENTS.md`.
