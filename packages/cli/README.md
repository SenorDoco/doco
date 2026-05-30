# doco-cli

The `doco` command-line interface for [Doco](https://doco.to) — an alignment framework
that documents and verifies the relationships between user intent, agent reasoning, and
agent actions.

## Install

```bash
npm install -g doco-cli
# or:
pnpm add -g doco-cli
```

This installs the `doco` binary on your `$PATH`.

## Why install globally?

Sandboxed coding agents (OpenAI Codex web, GitHub Coding Agent, Anthropic web sandbox,
etc.) block raw `curl` calls that expose bearer credentials in the command text. The CLI
reads `DOCO_ACCESS` from the environment (or `./.env`) *inside* the Node process, so the
credential never appears in a shell command — most sandboxes will then approve the network
call.

The single biggest lever for keeping agents unblocked in a sandboxed environment:

1. **Allowlist `doco.to`** in the sandbox's network settings.
2. **Add `npm install -g doco-cli` to the environment's setup script** so every agent
   session has `doco` on `$PATH` before it tries to bootstrap.
3. **Set `DOCO_ACCESS` as an environment secret** so the CLI can authenticate without
   a fresh `doco login` per session.

When npm/pnpm installs are blocked too, rely on the checked-in
`.agents/doco-agent-client.mjs` helper installed by `doco install-agent-bootstrap`.
It uses Node's built-in `fetch`, reads `DOCO_ACCESS` from `./.env` internally, and
supports the startup calls agents need:

```bash
node .agents/doco-agent-client.mjs bootstrap
node .agents/doco-agent-client.mjs search --q "what we know about auth"
```

## Quick start

```bash
# First create the Doco in the web UI:
#   https://doco.to/new-doco
# Then authorize this checkout:
doco login --host https://doco.to

# In an existing Doco project (Doco URL in .doco/connections.md, DOCO_ACCESS in ./.env):
doco install-agent-bootstrap                # drop AGENTS.md, MCP server, hooks
```

Run `doco --help` for the full command list. The CLI carries just two commands —
`login` (mint a token, write `.env` + `.doco/connections.md` + install bootstrap)
and `install-agent-bootstrap` (drop the discovery files into an existing repo).
Searching, capturing, and patching nodes all flow through the MCP server at
`.agents/doco-mcp-server.mjs` (auto-discovered by Claude Code, Cursor, and
Codex CLI) or the HTTP API at `https://doco.to/<handle>/api/`.

## Authentication

Two kinds of state, two homes:

- **`DOCO_ACCESS`, `DOCO_REFRESH`, `DOCO_CLIENT_ID`, `DOCO_HOST`** — OAuth credential set;
  *secret*. Lives in `./.env` (gitignored) or as environment secrets in your CI/agent runtime.
  Minted by `doco login`.
- **`.doco/connections.md`** — the public Doco URL; *non-secret*. Lives in the repo so every
  contributor and agent picks up the same project coordinate.

`doco login` writes the OAuth credential set to `./.env` and writes the Doco URL to
`.doco/connections.md` in one step.

After a repo is connected, commit and push the non-secret bootstrap files so other
contributors and agents discover the same Doco from their own clones:

```bash
test -f .doco/connections.md
test -f AGENTS.md
test -f CLAUDE.md
git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude
git commit -m "Connect repository to Doco"
git push
```

If `DOCO_ACCESS` already works but any of those files are missing, still add the
missing bootstrap files. Authorization proves the local runtime can reach Doco; it
does not tell the next clone that this repo is Doco-tracked.

Never commit `./.env`, `DOCO_ACCESS`, refresh tokens, OAuth client state, cookies, or any
other credential.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Links

- Homepage: [doco.to](https://doco.to)
- Source: [github.com/torrenegra/doco](https://github.com/torrenegra/doco)
