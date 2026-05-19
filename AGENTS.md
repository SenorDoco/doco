# 🛑 STOP — read this before doing anything else

You are in a **Doco-tracked project** — and specifically, you are in
the meta-Doco: Doco's own Doco. Decisions about Doco the product
live in the Doco described in:

@./DOCO.md

## Install the Doco MCP connector

To work with this Doco from any agent runtime — Claude Code, Claude
Desktop, Claude Cowork, ChatGPT Connectors, OpenAI Codex CLI,
Cursor, Gemini Code Assist, or any other MCP-supporting runtime —
install the Doco MCP server:

    https://doco.to/mcp/meta-doco

Per-runtime install commands:

| Runtime | Command / config |
|---|---|
| **Claude Code** (CLI) | `claude mcp add doco https://doco.to/mcp/meta-doco` |
| **Claude Desktop** | In `claude_desktop_config.json`, add `"doco": {"url": "https://doco.to/mcp/meta-doco"}` under `mcpServers` |
| **Claude Cowork** | Add the URL in the connector settings UI |
| **ChatGPT Connectors** | Add a custom MCP connector pointing at the URL |
| **OpenAI Codex CLI** | Add to `~/.codex/config.toml` under `[mcp_servers.doco]` |
| **Cursor** | Settings → MCP Servers → Add → URL |
| **Gemini Code Assist** | (MCP support in preview — check current docs) |

On first use, your runtime opens a browser tab to doco.to. Sign in
with GitHub, pick which Docos this runtime can access (meta-doco
should appear in the list once you've been invited), click Approve.
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

## Joining as a new contributor

If you don't yet have access, ask any existing collaborator on
meta-doco to mint an invite for you from the Doco's Invites page at
https://doco.to/meta-doco/invites. Open the invite URL in your
browser, sign in with GitHub, click Accept. From then on, when you
install the MCP connector above, meta-doco will appear in your list
of approvable Docos.

## If your runtime doesn't speak MCP yet

Ask the project owner. The MCP ecosystem is converging fast and most
agent runtimes have native MCP support. There is no fallback
HTTP/curl path: bearer-token-in-`.env` was retired in favor of
OAuth-via-MCP (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).

## What lives where

- **`DOCO.md`** (committed) — Doco URL.
- **`AGENTS.md`** (this file, committed) — agent bootstrap pointer.
- **`CLAUDE.md`** (committed) — one-line shim `@./AGENTS.md`.
