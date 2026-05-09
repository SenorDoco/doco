---
id: action_01KR441EAR39FGBD3KSRBG91AN
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 4: @evalo/api (Hono REST + token-store auth) and `evalo serve`. 8 endpoints, agent delete_evalo blocked via API returns HTTP 422."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: implement_phase
target: intent_01KR441EAEM5NQBM160763TDDT

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
  - intent_01KR441EACJYB895DWKG7Z25SF

decision_ids:
  - decision_01KR441EBZDSDGJGDX7GQTXEAY   # ADR-044 API-first
  - decision_01KR441EBR170TWHVZMZG0SVZS   # ADR-037 token lifecycle
  - decision_01KR441EBSMYJB6YMTGCRKTVZS   # ADR-038 strict revocation cascade
  - decision_01KR441EBTZDSJC0PEDTX4QHNE   # ADR-039 tokens external
  - decision_01KR441EABVKC40TW04ZF11T9E   # ADR-057 GitHub OAuth deferred
  - decision_01KR441EAC4VGX4QM3NFDEK1MW   # ADR-058 TokenStore JSON file

inputs:
  phase: 4

outputs:
  packages_created: [api]
  cli_added: [serve]
  endpoints: [
    "GET /api/v1/health",
    "GET /api/v1/evalo",
    "GET /api/v1/evalo/:type/:id",
    "GET /api/v1/evalo/:type",
    "POST /api/v1/query",
    "POST /api/v1/check",
    "GET /api/v1/lint",
  ]
  test_files: 1
  tests_pass: 8
  phase_end_demo: |
    - curl POST /api/v1/check (agent delete_evalo) → HTTP 422, blocked: true
    - curl /api/v1/query SELECT decision LIMIT 5 → 1.98 ms
    - curl /api/v1/lint → errors: 0
  commit: 8cfedf9

started_at: 2026-05-08T17:35:00Z
ended_at: 2026-05-08T17:45:00Z

created_at: 2026-05-08T17:45:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 4 — Hono REST + token-store auth

@evalo/api exports `makeApp({evaloRoot, requireToken, defaultPrincipalId})`
returning a Hono instance with auth middleware that resolves Bearer →
Principal via TokenStore. Local-dev mode uses `--as-principal` to act as a
named principal without a token (per ADR-057). All endpoints are stateless;
each request opens a fresh better-sqlite3 read-only handle (cheap with WAL).

Real GitHub OAuth lands in Phase 6 (ADR-053 deployment); the TokenStore
interface is unchanged between local-file and managed-DB backends.
