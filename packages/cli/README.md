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
# In a new directory:
doco login --host https://doco.to --create my-project

# In an existing Doco project (Doco URL in .doco/connections.md, DOCO_ACCESS in ./.env):
doco bootstrap                              # fetch the agent canonical
doco search "what we know about auth"       # query the graph
doco capture decision --question "..." --chosen "..."
doco patch decision <id> --append-body "Update YYYY-MM-DD: <what + why>."
```

Run `doco --help` for the full command list, and `doco <command> --help` for any
subcommand's flags.

## Authentication

Two values, two homes:

- **`DOCO_ACCESS`** — bearer; *secret*. Lives in `./.env` (gitignored) or as an
  environment secret in your CI/agent runtime. Minted by `doco login`.
- **`.doco/connections.md`** — the public Doco URL; *non-secret*. Lives in the repo so every
  contributor and agent picks up the same project coordinate.

`doco login` writes `DOCO_ACCESS` to `./.env` and writes the Doco URL to `.doco/connections.md`
in one step.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Links

- Homepage: [doco.to](https://doco.to)
- Source: [github.com/torrenegra/doco](https://github.com/torrenegra/doco)
