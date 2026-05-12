# Doco

Alignment framework and runtime checking system. Documents and verifies the
relationships between user intent, agent reasoning, and agent actions.

This repository is itself an Doco — see [doco.yaml](doco.yaml). The project's
own intents, rules, decisions, action, and reasoning are expressed in the schema
the project defines.

## Quick links

- [doco.yaml](doco.yaml) — root identity for this Doco.
- [schema/doco.schema.json](schema/doco.schema.json) — JSON Schema for every entity. Agents introspect this directly.
- [glossary.yaml](glossary.yaml) — term ↔ synonyms for Rule discovery.
- [SCHEMA.md](SCHEMA.md), [PLANNING.md](PLANNING.md), [DECISIONS.md](DECISIONS.md) — original prose design (kept; the per-entity files mirror them).

## Directory layout

```
.
├── doco.yaml                # Marks this directory as an Doco (D-002)
├── glossary.yaml             # Term → synonyms (D-032)
├── schema/
│   └── doco.schema.json     # JSON Schema for entities (embedded for self-comprehension)
├── principals/               # Humans + agents (D-018, D-034..D-036)
├── intents/                  # What the project intends (6 entities)
├── rules/                    # Constraints / invariants / runtime checks (5 entities)
├── decisions/                # 45 ADRs migrated from DECISIONS.md (ADR-001..ADR-045)
├── actions/                  # Things done (bootstrap so far)
├── reasoning/                # Inferential bridges (Premises → Conclusion)
├── references/               # Pointers to external resources (incl. PLANNING/SCHEMA/DECISIONS)
├── tags/                     # Reserved + custom tags
├── evaluations/              # Append-only Rule run results (empty for now)
└── docs/                     # Reserved for additional human documentation
```

## Status

**Day 0: 2026-05-08.** The framework is being defined from first principles in
collaboration between [torrenegra](principals/torrenegra.yaml)
(human, founder) and [claude-opus-4-7](principals/claude-opus-4-7.yaml)
(agent, invited 2026-05-08T15:42:00Z).

The bootstrap action that produced this directory tree is recorded at
[actions/action_01KR441EC1HG8M0PGYMR5EQDMM.md](actions/action_01KR441EC1HG8M0PGYMR5EQDMM.md),
authorized by the foundational ADRs (ADR-002, ADR-003, ADR-009).

## What's next

Per [intent_01KR441EAEM5NQBM160763TDDT.md](intents/intent_01KR441EAEM5NQBM160763TDDT.md)
(implementation-v0):

1. CLI core (`doco init`, `init --existing`, `show`, `query`).
2. Source-of-truth layer — readers/writers + JSON-Schema validation.
3. Index layer — SQLite + FTS5 cache, `edges` adjacency, `scope_match`.
4. Identity — GitHub OAuth + invitation/session tokens.
5. API server (REST + OpenAPI).
6. Web app — recent-changes feed, list views, entity detail, graph as drill-down.
7. Importers — Slack, GitHub PRs, agent transcripts.
8. Rule discovery — `doco find-rules` + embedding index.
9. System Rules + lints.

## Reading order for a new agent

1. [doco.yaml](doco.yaml) — what this Doco is.
2. [schema/doco.schema.json](schema/doco.schema.json) — entity shapes.
3. [intents/](intents/) — what the project intends to accomplish.
4. [rules/](rules/) — what must hold.
5. [decisions/](decisions/) — settled choices and their rationale.
6. [actions/](actions/) and [reasoning/](reasoning/) — what happened and why.

## Reading order for a new human

1. This README.
2. [SCHEMA.md](SCHEMA.md) — design narrative for the schema.
3. [PLANNING.md](PLANNING.md) — design narrative for product flows.
4. [DECISIONS.md](DECISIONS.md) — settled decisions with rationale.
5. (Then dive into per-entity files when something needs to change.)
