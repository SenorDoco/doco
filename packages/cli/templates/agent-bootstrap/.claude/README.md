# `.claude/` — Claude Code enforcement layer (optional, additive)

This directory is **Claude Code–specific** configuration. It is **not**
required to use Doco, and it is **not** where the Doco protocol lives.
If you work in Cursor, Codex CLI, or any other MCP-aware agent, you can
ignore — or delete — everything in here.

## The Doco core is agent-agnostic

Doco reaches *any* agent through runtime-neutral files that ship in the
same bootstrap:

- **`AGENTS.md`** (+ the one-line `CLAUDE.md` shim) — the protocol
  itself, read by Claude Code, Cursor, Codex, and others.
- **`.mcp.json`** → **`.agents/doco-mcp-server.mjs`** — an MCP server
  exposing `doco_search`, `doco_authenticate`, and
  `doco_complete_authentication`, auto-discovered by any MCP-aware
  client.
- **`.agents/doco-agent-client.mjs`** — the HTTP client the above call.

An agent that reads `AGENTS.md` or speaks MCP gets the full protocol
with none of the files in this directory.

## What `.claude/` adds, and why it's here anyway

Claude Code is the one runtime that supports deterministic **lifecycle
hooks**. They make the protocol fire *automatically* instead of relying
on the model to remember to call a tool:

| File | Hook event | Role |
| --- | --- | --- |
| `settings.json` | — | permission allowlist + the hook wiring below |
| `bootstrap-fetch.sh` | `SessionStart` | load canonical instructions, scopes, and constitution into context |
| `user-prompt-fetch.sh` | `UserPromptSubmit` | re-push the protocol and pre-fetch a search every turn |
| `post-tool-use-check.sh` | `PostToolUse` | nudge to PATCH a governing Decision after an edit |
| `stop-check.sh` | `Stop` | nudge if you edited but didn't capture, or wrote without pasting footers |

These scripts are Claude Code glue — the protocol's actual read/write
logic lives in the agent-agnostic `.agents/` layer they call into. So
`.claude/` is an **enforcement bonus** for one runtime, layered on top
of an agnostic core: MCP *exposes* the capability to every agent; hooks
*guarantee* it fires for Claude Code.

No `.cursor/` or Codex-specific equivalent ships today — those runtimes
get the agnostic floor (MCP + `AGENTS.md`). Adding hook parity for them
is a deliberate future choice, not an accident.

> Editor/IDE files (e.g. a VS Code `launch.json`) do **not** belong
> here — they go in `.vscode/` (gitignored). Keep this directory to
> Claude Code config only.
