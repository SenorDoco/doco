# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project**. Doco coordinates this project's
intent, decisions, rules, actions, and logs. The Doco URL + handle
for this project live in:

@./DOCO.md

## Install the Doco MCP connector

To work with this Doco from any agent runtime — Claude Code, Claude
Desktop, Claude Cowork, ChatGPT Connectors, OpenAI Codex CLI,
Cursor, Gemini Code Assist, or any other MCP-supporting runtime —
install the Doco MCP server:

    https://doco.to/mcp/<doco-handle>

(Replace `<doco-handle>` with the handle from `DOCO.md`.)

Per-runtime install commands:

| Runtime | Command / config |
|---|---|
| **Claude Code** (CLI) | `claude mcp add doco https://doco.to/mcp/<handle>` |
| **Claude Desktop** | In `claude_desktop_config.json`, add `"doco": {"url": "https://doco.to/mcp/<handle>"}` under `mcpServers` |
| **Claude Cowork** | Add the URL in the connector settings UI |
| **ChatGPT Connectors** | Add a custom MCP connector pointing at the URL |
| **OpenAI Codex CLI** | Add to `~/.codex/config.toml` under `[mcp_servers.doco]` |
| **Cursor** | Settings → MCP Servers → Add → URL |
| **Gemini Code Assist** | (MCP support in preview — check current docs) |

On first use, your runtime opens a browser tab to doco.to. Sign in
with GitHub, pick which Docos this runtime can access, click Approve.
The runtime stores the resulting OAuth access token in its native
credential store — no `.env`, no copy/paste, no env vars to set.

If the token ever expires or you revoke it from the doco.to UI, the
next MCP call returns `401 + WWW-Authenticate: Bearer` and your
runtime re-runs the OAuth flow automatically.

## What you get once connected

The MCP server exposes:

- **Tools** for reading + writing Doco nodes: `search`, `bootstrap`,
  `list_scopes`, `get_status`, `capture_decision`, `patch_rule`,
  `create_invite`, … (full list via `tools/list`).
- **Resources** for the protocol prose:
  - `doco://protocol/canonical-instructions` — the four invariants
    every reply must follow (query indicator, footer lines,
    capture-before-done, tally). Fetch this on session start.
  - `doco://protocol/agent-reference` — long-form reference; fetch
    on demand.

## If your runtime doesn't speak MCP yet

Ask the project owner. The MCP ecosystem is converging fast and most
agent runtimes have native MCP support. There is no fallback
HTTP/curl path: bearer-token-in-`.env` was retired in favor of
OAuth-via-MCP.

## What lives where

- **`DOCO.md`** (committed) — Doco URL + handle. The discoverability
  marker any teammate or future agent sees on their first clone.
- **`AGENTS.md`** (this file, committed) — agent bootstrap pointer.
- **`CLAUDE.md`** (committed) — one-line shim `@./AGENTS.md`.
