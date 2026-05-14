# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project**. The user expects you to follow
the Doco agent protocol — query indicator at the top of every reply,
scope-prefixed footer lines after every write, the four-step cognitive
loop (read → understand → decide → show), the scope authoring
guidelines. Skipping the protocol means your reply *looks wrong* and
the user will call you out.

## Before you respond to ANY message — fetch your real instructions

```
curl -s "$DOCO_HOST/api/v1/agent-bootstrap" -H "Authorization: Bearer $DOCO_TOKEN"
```

Read the `canonical_instructions` field of the response. Read it
**before** addressing the user's request, even if the task seems
trivial (typo fix, single-string replace, one-line edit). The protocol
applies to every reply — there is no "small enough to skip" threshold.

The same response also includes this Doco's scopes (with their
icons + purpose + guidelines), known lint issues, and recent activity.
Skim those too.

Two `.claude/settings.json` hooks keep the protocol fresh automatically:

- **`SessionStart`** (runs once per session: startup/resume/clear/compact)
  fetches `canonical_instructions` and injects it as additional context.
- **`UserPromptSubmit`** (runs on every user message) re-injects a
  tight protocol checklist AND pre-fetches `/search.json` for the
  prompt so the top-of-reply query indicator is pre-built — paste the
  `[🔮 Doco] Connected to <doco>. <N> nodes (<X.X>s)` block verbatim.

If you see those blocks at the top of your context, the hooks worked
— follow what they say. If not, run the curl manually.

## If `DOCO_HOST`, `DOCO_TOKEN`, or `DOCO_SLUG` aren't set

Check `./.env` (gitignored). The hooks read three vars:

- `DOCO_HOST` — your host URL (e.g. `http://localhost:5173` or
  `https://doco.example.com`).
- `DOCO_TOKEN` — bearer token for write capture + per-Doco context
  on the bootstrap response.
- `DOCO_SLUG` — `<owner>/<doco>` (e.g. `acme/payments`); tells the
  UserPromptSubmit hook which Doco to query.

If any are missing, ask the user to visit the host, copy them, and
paste into `./.env`. Don't start work without the bootstrap fetched.

## If the bootstrap fetch fails — stop and ask

If `curl` returns nothing or non-200, or the SessionStart hook
injected a "⚠️ Doco bootstrap not loaded" warning instead of the
canonical (host down, network error, expired token, wrong
`DOCO_HOST`), **stop and ask the user** before doing anything else.
Two paths; the user picks:

1. **Continue without Doco** for this session — proceed without the
   protocol. No query indicator, no captures, no footer/tally lines.
   Useful when the host is genuinely unavailable and the task can't
   wait.
2. **Retry until connected** — pause while the user starts the host
   / restores the network / fixes `.env`, then re-curl until the
   bootstrap loads. No work happens until it does.

Don't pick yourself — the right answer depends on context you don't
have (is the host expected to come back, is the task time-sensitive,
is the user OK losing the trail). Ask in plain prose and wait.
Never silently degrade.

## If you don't see the canonical block at all — hooks aren't approved

Distinct failure mode from above. When the SessionStart hook fires
successfully it injects a context block whose first line is exactly:

```
🔒 Doco canonical_instructions — auto-loaded by SessionStart hook at <timestamp>
```

If you scan your context and that block is **absent entirely** (no
warning either — just nothing), the hook didn't fire. Most likely
cause on Claude Code: the project's hooks haven't been approved yet.
Claude Code stores per-project approval in `~/.claude.json` at
`projects["<cwd>"].hooksApprovedDigest`. While that value is `null`,
**every hook in `.claude/settings.json` is silently skipped** — no
warning, no error, just absence. The SessionStart canonical doesn't
load AND the per-prompt UserPromptSubmit protocol checklist doesn't
re-inject, so even after you curl the canonical manually, you'll
drift as the context scrolls.

Diagnose: `jq '.projects["'"$PWD"'"].hooksApprovedDigest' ~/.claude.json`.
If `null`, that's the cause.

Fix: ask the user to run `/hooks` in Claude Code, review the listed
hooks (SessionStart + UserPromptSubmit, both running scripts in
`.claude/`), and approve them. Then `/clear` (or quit and re-open
Claude Code) so SessionStart fires fresh. Tell the user the same fix
is needed independently for each git worktree they run agents in —
approval is keyed to working-directory path, so `.claude/worktrees/*`
agents need their own approval pass.

Until approval lands: you can curl the canonical manually each turn
to stay informed, but you're working without the per-prompt
protocol-freshness hook. Flag that to the user — running unprotected
is OK for one turn, not for a long session.

## What lives where

- **`canonical_instructions`** — the cross-Doco protocol every agent
  must follow. Served live by the Doco host. This file points at it.
- **This file** — auto-loaded by Claude Code as `CLAUDE.md`. Also
  available as `AGENT.md` (symlink → `CLAUDE.md`) for non-Claude-Code
  agents following the broader convention. **One file, two filenames;
  edit once.**
- Both files come from the CLI template at
  `packages/cli/templates/agent-bootstrap/CLAUDE.md`. To change this
  text, edit that template and re-run `doco install-agent-bootstrap`
  in any repo that should pick it up.

If you find yourself wanting to add **protocol** content to this file
(message shape, footer format, capture triggers, icon dictionary,
scope guidelines), don't — add it to `packages/api/src/instructions.ts`
instead and rebuild. The bootstrap endpoint will serve it on next
session start.
