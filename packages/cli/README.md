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
etc.) block raw `curl` calls that expose bearer tokens in the command text. The CLI
reads `DOCO_TOKEN` from the environment (or `./.env`) *inside* the Node process, so the
token never appears in a shell command — most sandboxes will then approve the network
call.

The single biggest lever for keeping agents unblocked in a sandboxed environment:

1. **Allowlist `doco.to`** in the sandbox's network settings.
2. **Add `npm install -g doco-cli` to the environment's setup script** so every agent
   session has `doco` on `$PATH` before it tries to bootstrap.
3. **Set `DOCO_TOKEN` as an environment secret** so the CLI can authenticate without
   a fresh `doco login` per session.

## Quick start

```bash
# In a new directory:
doco login --host https://doco.to --create my-project

# In an existing Doco project (DOCO_ID in AGENTS.md, DOCO_TOKEN in ./.env):
doco bootstrap                              # fetch the agent canonical
doco search "what we know about auth"       # query the graph
doco capture decision --question "..." --chosen "..." --scope <comma,list>
doco patch decision <id> --append-body "Update YYYY-MM-DD: <what + why>."
```

Run `doco --help` for the full command list, and `doco <command> --help` for any
subcommand's flags.

## Authentication

Two values, two homes:

- **`DOCO_TOKEN`** — bearer; *secret*. Lives in `./.env` (gitignored) or as an
  environment secret in your CI/agent runtime. Minted by `doco login`.
- **`DOCO_ID`** — the immutable `doco_...` id; *non-secret*. Lives at the top of
  `AGENTS.md` so every contributor (and every agent) picks up the same value.

`doco login` writes `DOCO_TOKEN` to `./.env` and stamps `DOCO_ID` into `AGENTS.md` in
one step.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Links

- Homepage: [doco.to](https://doco.to)
- Source: [github.com/torrenegra/doco](https://github.com/torrenegra/doco)
