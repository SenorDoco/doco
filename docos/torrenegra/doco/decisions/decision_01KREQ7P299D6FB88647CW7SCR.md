---
id: decision_01KREQ7P299D6FB88647CW7SCR
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"

slug: drop-single-doco-mode
number: "ADR-093"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
follows:
  - decision_01KREQ7P27K069RBX42APKTBQX   # ADR-092 (hosted is the only shape)
summary: "Single-doco mode goes away. Meta-doco migrates to host shape (host.yaml + docos/torrenegra/doco/). Web auto-detection collapses to host-only. `doco init` writes a Doco under an existing host."

question: "ADR-092 says hosted multi-tenant is the only shape. Single-doco mode currently exists in code (db.ts `getMode()`, all single-doco routes, packages/cli/src/commands/init.ts writing doco.yaml at root, the meta-doco itself uses single-doco mode). What gets ripped out, and what's the migration path for the meta-doco?"

chosen: |
  ### Code removals

  - `getMode()` in `packages/web/app/lib/db.ts` — gone. Web always
    runs in host mode.
  - `openDb()` (single-doco entry to root cache.db) — gone. Replaced
    by `openDocoDb(ownerSlug, docoSlug)` everywhere.
  - Single-doco routes in `packages/web/app/routes/`: `_index.tsx`,
    `e.$type._index.tsx`, `e.$type.$id.tsx`, `search.tsx`, `lint.tsx` —
    deleted. The owner-prefixed equivalents
    (`$ownerSlug.$docoSlug.*`) are the only entity routes.
  - The single-doco root index becomes the host home (list of owners
    + Docos).
  - `/api/v1/doco`, `/api/v1/doco/:type`, `/api/v1/doco/:type/:id`,
    `/api/v1/query`, `/api/v1/check`, `/api/v1/suggest`,
    `/api/v1/lint`, `/api/v1/agent-bootstrap` — all gain an
    owner+slug scoping. New endpoints:
    `/api/v1/host/:owner/:doco/{...}` with the same semantics. The
    bare `/api/v1/doco` family is deprecated and removed.
  - `packages/cli/src/commands/init.ts` — rewritten as `doco doco
    init <slug>` (creates a Doco under an existing host) and `doco
    host init` (already exists). The bare `doco init` is removed.
  - `packages/web/app/lib/db.ts:rootDir()` — only matches `host.yaml`;
    no `doco.yaml` fallback.

  ### Meta-doco migration

  The repository at `/Users/torrenegra/Evalo` currently runs as a
  single-doco. After this Decision:

  - **Create** `host.yaml` at `/Users/torrenegra/Evalo/`.
  - **Move** every entity directory + `doco.yaml` + `glossary.yaml`
    + `schema/` into `/Users/torrenegra/Evalo/docos/torrenegra/doco/`.
  - **Keep** `principals/` at the host root (Principals are
    host-level, not Doco-level).
  - **Keep** `.doco/` at the host root *and* inside each Doco
    directory — the host has its own meta-cache (Principals, Org
    list, Doco list) and each Doco has its own.
  - Update `.gitignore` to keep `.doco/` ignored at every level.
  - **Re-bootstrap** the index: `doco reindex` for the host and for
    `docos/torrenegra/doco/`.

  The meta-doco's slug stays `torrenegra/doco`, so the URL
  `/<owner>/<doco>` becomes `/torrenegra/doco` — exactly what the
  hosted routes already expect.

  ### Vocabulary

  - "Single-doco mode", "local-solo", "solo Doco" — phased out in
    new prose. Existing historical Decisions/Actions that mention
    them stay as-is (history is append-only). Marked `superseded_by:
    ADR-092` where they prescribed a mechanism that's now gone.
  - "Mode" disappears as a concept. The system has one shape.

alternatives:
  - name: Keep single-doco mode but mark it deprecated
    rejected_because: "Deprecated code rots and confuses agents. The user explicitly said 'Solo Doco should be a thing of the past. We shouldn't make reference to that anywhere moving forward.' Delete, don't deprecate."
  - name: Keep the meta-doco in single-doco mode forever as a special case
    rejected_because: "Then the meta-doco is the only single-doco in existence. Every reader sees the meta-doco as the canonical example and assumes single-doco is the shape. We can't dogfood hosted-multi-tenant from a single-doco meta. Migrate."
  - name: Hold off — wait until production deploy
    rejected_because: "Single-doco mode keeps confusing the codebase (two modes; some features land in one and not the other). The removal blocks public deploy at the architectural level. Do it now."

rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-12T13:00:00Z

created_at: 2026-05-12T13:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-093 — Drop single-doco mode; meta-doco migrates to host shape

## Migration of the meta-doco

Before:
```
/Users/torrenegra/Evalo/
├── doco.yaml
├── glossary.yaml
├── schema/doco.schema.json
├── actions/   decisions/   intents/   ideas/   rules/
├── references/   reasoning/   scopes/   evaluations/
├── principals/
└── .doco/cache.db
```

After:
```
/Users/torrenegra/Evalo/
├── host.yaml                            ← new
├── principals/                          ← stays host-level
└── docos/torrenegra/doco/
    ├── doco.yaml                        ← moved
    ├── glossary.yaml                    ← moved
    ├── schema/doco.schema.json          ← moved
    ├── actions/   decisions/   intents/   ideas/   rules/
    ├── references/   reasoning/   scopes/   evaluations/
    └── .doco/cache.db                   ← per-Doco cache
```

## Code changes summary

| Surface | Before | After |
|---|---|---|
| `db.ts` mode detection | `host.yaml`-or-`doco.yaml` walk | `host.yaml`-only walk |
| Web routes | dual: bare paths + owner-prefixed | owner-prefixed only |
| CLI `doco init` | writes a single Doco at cwd | writes a Doco under an existing host |
| API endpoints | `/api/v1/doco/...` | `/api/v1/host/<owner>/<doco>/...` |

## What lands in this Decision's commit

This Decision is shipped in advance of the code migration (which is
captured by a sibling Action). Adjustments to the canonical
instructions, AGENT.md, PLANNING.md, SCHEMA.md follow the code in a
sweep commit.
