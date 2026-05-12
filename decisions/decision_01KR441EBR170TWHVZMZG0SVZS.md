---
id: decision_01KR441EBR170TWHVZMZG0SVZS
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Two-phase token lifecycle: 5-minute invitation token (single-use, URL-shareable) bootstraps a long-lived session token (no default expiry, env-stored, revocable)."

slug: token-lifecycle-invitation-then-session
number: "ADR-037"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "How do agents get authenticated for first-time bootstrap and ongoing operation?"
chosen: |
  Two-phase tokens:
    - **Invitation token** — 5-minute, single-use, URL-shareable. Used once
      to create the agent's `Principal` and exchange for a session token.
    - **Session token** — no default expiry, stored in `DOCO_TOKEN`
      environment variable, always revocable. Long-lived agent access.
alternatives:
  - name: Single token type
    rejected_because: "Loses the bootstrap-vs-runtime separation. Either invite tokens are too long-lived (security) or session tokens too short (operational toil)."
  - name: Session tokens with default TTL
    rejected_because: "Operational toil for long-running agents; revocation is the correct revocation mechanism, not expiry."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-037 — Token lifecycle: 5-min invitation → long-lived session

Narrow blast radius for leaked invite URLs (5-min window); agents can persist
session tokens for ongoing work.

Reference: PLANNING.md §3.1, §3.2.
