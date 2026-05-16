# Doco

Alignment framework and runtime checking system. Documents and verifies the
relationships between user intent, agent reasoning, and agent actions.

This repository is itself a Doco Host serving its own Doco at
[torrenegra/doco](docos/torrenegra/doco/doco.yaml). Entities (Intents,
Decisions, Rules, Actions, Reasoning, Evals, References, Principals,
Scopes) live in Postgres and are reached through the web app and HTTP
API — there are no on-disk per-entity files to read here.

## Quick links

- [AGENTS.md](AGENTS.md) — agent bootstrap. Every agent working in this
  repo should run `doco bootstrap` before doing anything else; it fetches
  the live `canonical_instructions` without exposing the bearer token in
  the shell command.
- [docos/torrenegra/doco/doco.yaml](docos/torrenegra/doco/doco.yaml) —
  this Doco's identity stub. Durable data is in Postgres.
- [packages/db/src/schema.sql](packages/db/src/schema.sql) — current
  database schema (single source of truth for storage).
- [packages/shared/src/entities.ts](packages/shared/src/entities.ts) —
  TypeScript types for every entity (single source of truth for shape).
- [SCHEMA.md](SCHEMA.md), [PLANNING.md](PLANNING.md),
  [DECISIONS.md](DECISIONS.md) — historical prose design. Most of the
  schema-level content is superseded; the design rationale (§1 of
  SCHEMA.md) is still load-bearing.

## Repository layout

```
.
├── AGENTS.md                # Agent bootstrap (also imported by CLAUDE.md)
├── host.yaml                # Host root marker (Postgres `hosts` table is authoritative)
├── docos/<owner>/<slug>/    # Per-Doco scaffolding stubs (doco.yaml only — entities are in PG)
├── packages/
│   ├── api/                 # JSON/text routes shared between web + CLI
│   ├── cli/                 # `doco` command (init, capture, patch, watch, import, export, …)
│   ├── db/                  # Postgres adapter + schema.sql
│   ├── host/                # Host/Doco/Principal/Organization domain layer
│   ├── index/               # Edge derivation + embedding index helpers
│   ├── lints/               # Lint registry + checks
│   ├── shared/              # TypeScript entity types + URL conventions
│   └── web/                 # React Router web app (`doco.to`-shaped UI)
└── SCHEMA.md / PLANNING.md / DECISIONS.md / NOTICE / LICENSE
```

## Install the CLI

```bash
npm install -g doco-cli
```

This installs the `doco` binary on your `$PATH`. For sandboxed coding
agents (OpenAI Codex web, GitHub Coding Agent, Anthropic web sandbox),
add the same line to your environment's **setup script** and allowlist
`doco.to` in the network-access settings — that combination keeps the
bearer token inside the Node process so the sandbox stops prompting on
every bootstrap call.

## Reading order for a new agent

1. [AGENTS.md](AGENTS.md) — protocol, bootstrap, env setup.
2. `doco bootstrap` — live `canonical_instructions`, including the four
   invariants every reply must follow.
3. `doco search "<task>"` — query Doco before drafting a Decision, Rule,
   or Intent.

## Reading order for a new person

1. This README.
2. [SCHEMA.md](SCHEMA.md) §1 — design philosophy → priority mapping
   (the rest is historical).
3. [PLANNING.md](PLANNING.md) — design narrative for product flows.
4. [DECISIONS.md](DECISIONS.md) — early ADRs with rationale; later
   decisions live in the Doco itself.
