---
id: decision_01KR441EA74735F85475FZBXQ3
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Evalo is dual-distributed: open-source self-hostable codebase under Apache-2.0; SaaS at evalo.to deployed on Vercel (deployment in phase 6)."

slug: dual-distribution-oss-and-saas
number: "ADR-053"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Is Evalo a SaaS, an open-source self-hostable tool, or both?"
chosen: |
  Both. The codebase is open-source under Apache-2.0 (D-047) and runs
  self-hosted (Node host of choice). evalo.to is the SaaS deployed on
  Vercel as a hosted offering. Phases 1-5 build the codebase; phase 6
  deploys evalo.to.

  Self-hosted and SaaS share the same codebase; SaaS has additional
  configuration (managed Postgres for tokens, OpenAI embeddings default,
  paid-tier rate limits) layered over it.
alternatives:
  - name: SaaS only
    rejected_because: "Conflicts with the 'agents are first-class users' intent — agents must run in any environment, including air-gapped CI."
  - name: OSS only (no SaaS)
    rejected_because: "Loses the sustainable-funding lever and the easy-onboarding path for non-technical teams."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-053 — Dual distribution: OSS + SaaS at evalo.to

## Phase boundaries

- **Phases 1-5** (this implementation pass): everything runs on `localhost`.
  No public deployment, no domain wiring, no managed services.
- **Phase 6**: deploy `evalo.to` on Vercel. Add managed Postgres (Neon /
  Supabase) for the token store. Configure OpenAI embeddings.

## Vercel suitability check

- API: Hono runs on Vercel functions natively.
- Web: Remix runs on Vercel (Node runtime, not Edge — better-sqlite3 is
  not Edge-compatible).
- SQLite index: per-clone, per-deployment cache; rebuilt from source on
  cold start (acceptable at Tier B scale per ADR-049). For SaaS shared
  state across multiple Vercel functions, the source-of-truth files live
  in a Postgres-backed object store, with the SQLite cache regenerated
  per-instance. (Architecture detail to be designed in phase 6.)
