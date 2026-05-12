---
id: decision_01KR441EBZDSDGJGDX7GQTXEAY
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Public REST + JSON API at /api/v1/...; the web app is a consumer of the API. No parallel implementation."

slug: api-first-web-is-a-consumer
number: "ADR-044"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Do humans interact with Doco through a web app and agents through an API, or are they the same surface?"
chosen: |
  Same surface. Public REST + JSON API at `/api/v1/...` is primary. The web
  interface is a consumer of the API — not a parallel implementation. This
  guarantees:
    - Anything a human can do, an agent can do.
    - Anything a human can do is documented (the API IS the documentation).
    - Feature parity is mechanical, not maintained by hand.
  OpenAPI schema served at `/api/v1/openapi.json`. Agents consume it directly —
  no separate SDK needed.
alternatives:
  - name: Separate web-only and API-only paths
    rejected_because: "Drift inevitably; agents and humans gain capabilities asymmetrically; conflicts with intent_01KR441EACJYB895DWKG7Z25SF (dual-user-model)."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:31:00Z

created_at: 2026-05-08T15:31:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-044 — API-first; web is a consumer

Reference: PLANNING.md §5.1, §5.2.
