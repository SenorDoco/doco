# Doco

Alignment framework and runtime checking system. Documents and verifies the
relationships between user intent, agent reasoning, and agent actions.

This repository is a Doco Host. Entities (Intents, Decisions, Rules,
Actions, Reasoning, Evals, References, Principals, Scopes) live in
Postgres and are reached through the web app and HTTP API — there are
no on-disk per-entity files to read here.

## Quick links

- [AGENTS.md](AGENTS.md) — agent bootstrap. Every agent working in this
  repo should run `node .agents/doco-agent-client.mjs bootstrap`
  before doing anything else; the helper reads `DOCO_ACCESS` internally
  so the credential stays out of shell command text, and the
  response carries the live `canonical_instructions`.
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
│   ├── api/                 # JSON/text routes
│   ├── db/                  # Postgres adapter + schema.sql
│   ├── host/                # Host/Doco/Principal/Organization domain layer
│   ├── index/               # Edge derivation + embedding index helpers
│   ├── shared/              # TypeScript entity types + URL conventions
│   └── web/                 # React Router web app (`doco.to`-shaped UI)
└── SCHEMA.md / PLANNING.md / DECISIONS.md / NOTICE / LICENSE
```

## Connecting an agent (zero install)

An agent needs two pieces of state:

1. `doco.md` with the public Doco URL.
2. `./.env` with `DOCO_ACCESS=<credential>`.

From then on every API call sends `Authorization: Bearer
$DOCO_ACCESS`; no secret appears in the URL. See
`/onboarding/create/agent.txt` and `/onboarding/join/agent.txt` on
this host for the complete recipes.

## Reading order for a new agent

1. [AGENTS.md](AGENTS.md) — protocol, bootstrap, env setup.
2. `node .agents/doco-agent-client.mjs bootstrap` — live `canonical_instructions`, including the four invariants every reply must follow.
3. `node .agents/doco-agent-client.mjs search --q "<task>"` — query Doco before drafting a Decision, Rule, or Intent.

## Reading order for a new person

1. This README.
2. [SCHEMA.md](SCHEMA.md) §1 — design philosophy → priority mapping
   (the rest is historical).
3. [PLANNING.md](PLANNING.md) — design narrative for product flows.
4. [DECISIONS.md](DECISIONS.md) — early ADRs with rationale; later
   decisions live in the Doco itself.
