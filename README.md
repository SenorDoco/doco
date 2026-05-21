# Doco

Alignment framework and runtime checking system. Documents and verifies the
relationships between user intent, agent reasoning, and agent actions.

This repository is itself a Doco Host. Durable entities (Intents,
Decisions, Rules, Actions, Logs, Evals, References, Principals, and
Organizations) live in Postgres and are reached through the web app and
HTTP API — there are no on-disk per-entity files to read here.

## Quick links

- [.agents/doco-agent-client.mjs](.agents/doco-agent-client.mjs) —
  local helper that reads credentials inside Node so bearer tokens stay
  out of shell command text.
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
├── host.yaml                # Host root marker (Postgres `hosts` table is authoritative)
├── docos/<owner>/<slug>/    # Historical scaffolding stubs; durable entities are in PG
├── packages/
│   ├── db/                  # Postgres adapter + schema.sql
│   ├── host/                # Host/Doco/Principal/Organization domain layer
│   ├── index/               # Edge derivation + embedding index helpers
│   ├── shared/              # TypeScript entity types + URL conventions
│   └── web/                 # React Router web app (`doco.to`-shaped UI)
└── SCHEMA.md / PLANNING.md / DECISIONS.md / NOTICE / LICENSE
```

## Connecting an agent (zero install)

An agent needs two pieces of state:

1. `.doco/connections.md` with the public Doco URL. Commit and push
   this file so agents in other clones know the repo is Doco-tracked.
2. `./.env` with `DOCO_ACCESS=<oauth-access-token>`. This is secret
   and must stay local or in the agent runtime's secret store.

From then on every API call sends `Authorization: Bearer
$DOCO_ACCESS`; no secret appears in the URL. See `/llms.txt` on
this host for the complete recipe.

When `doco login` or `doco install-agent-bootstrap` creates or updates
bootstrap files, commit only the non-secret ones:

```sh
test -f .doco/connections.md
test -f AGENTS.md
test -f CLAUDE.md
git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude
git commit -m "Connect repository to Doco"
git push
```

If you already have a working `DOCO_ACCESS` token but any of those
files are missing, still add the missing bootstrap files before
declaring setup done.

Never commit `.env`, `DOCO_ACCESS`, refresh tokens, OAuth client state,
cookies, or other credentials.

## Reading order for a new agent

1. `node .agents/doco-agent-client.mjs bootstrap` — live
   `canonical_instructions`, including the invariants every reply must
   follow.
2. `node .agents/doco-agent-client.mjs search --q "<task>"` — query
   Doco before drafting a Decision, Rule, or Intent.

## Reading order for a new person

1. This README.
2. [SCHEMA.md](SCHEMA.md) §1 — design philosophy → priority mapping
   (the rest is historical).
3. [PLANNING.md](PLANNING.md) — design narrative for product flows.
4. [DECISIONS.md](DECISIONS.md) — early ADRs with rationale; later
   decisions live in the Doco itself.
