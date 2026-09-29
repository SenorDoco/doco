# Doco

Alignment framework and runtime checking system. Documents and verifies the
relationships between user intent, agent reasoning, and agent actions.

This repository is itself a Doco Host. Durable entities (Intents,
Decisions, Rules, Actions, Logs, Evals, References, Principals, and
Workspaces) live in Postgres and are reached through the web app and
HTTP API — there are no on-disk per-entity files to read here.

## Quick links

- [.agents/doco-agent-client.mjs](.agents/doco-agent-client.mjs) —
  local helper that reads credentials inside Node so bearer tokens stay
  out of shell command text.
- [packages/db/src/schema.sql](packages/db/src/schema.sql) — current
  database schema (single source of truth for storage).
- [packages/shared/src/entities.ts](packages/shared/src/entities.ts) —
  TypeScript types for every entity (single source of truth for shape).
- [AGENTS.md](AGENTS.md) — the Doco protocol every agent follows in this
  repo (indicators, search-before-answer, captures).

Design rationale is recorded in the project's own Doco (see
[.doco/connections.md](.doco/connections.md)). A v0.1 product narrative is
kept in [PLANNING.md](PLANNING.md) for historical context.

## Repository layout

```
.
├── packages/
│   ├── db/                  # Postgres adapter, schema.sql + numbered migrations
│   ├── host/                # Host/Doco/Principal/Workspace domain layer
│   ├── index/               # Edge derivation + embedding index helpers
│   ├── shared/              # TypeScript entity types + URL conventions
│   └── web/                 # React Router web app (`doco.to`-shaped UI)
├── .agents/                 # Bundled Doco MCP server + agent HTTP client
├── .claude/                 # Claude Code hooks (bootstrap, search, checks)
├── .doco/connections.md     # The Doco URL this repo is tracked in
└── AGENTS.md / CLAUDE.md / PLANNING.md / NOTICE / LICENSE
```

## Connecting an agent (zero install)

The home page of the host (https://doco.to) holds the instructions to
give an agent, with a Copy button. The agent connects through the hosted
MCP server at `/mcp`, picks the project's workspace with the user, and
keeps the instructions in the project's `AGENTS.md` (or similar), checked
against the home page so they stay current. People create workspaces;
agents never do.

Agents that can't speak MCP drive OAuth directly, following
`/protocol/agent-oauth-recipe`. Never commit `.env`, `DOCO_ACCESS`,
refresh tokens, OAuth client state, cookies, or other credentials.

## Reading order for a new agent

1. `node .agents/doco-agent-client.mjs bootstrap` — live
   `canonical_instructions`, including the invariants every reply must
   follow.
2. `node .agents/doco-agent-client.mjs search --q "<task>"` — query
   Doco before drafting a Decision, Rule, or Intent.

## Reading order for a new person

1. This README.
2. [packages/db/src/schema.sql](packages/db/src/schema.sql) — the data
   model as built (the single source of truth for storage).
3. [packages/shared/src/entities.ts](packages/shared/src/entities.ts) —
   entity shapes in TypeScript.
4. [AGENTS.md](AGENTS.md) — how agents and people share context through
   the Doco.
5. [PLANNING.md](PLANNING.md) — historical v0.1 product narrative
   (design rationale; superseded specifics are flagged inline).
