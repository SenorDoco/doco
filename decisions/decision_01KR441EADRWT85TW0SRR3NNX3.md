---
id: decision_01KR441EADRWT85TW0SRR3NNX3
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Invitation flow implementation: token in URL fragment (not query), host-level scope, single TokenStore for invitation + session tokens, 5-min single-use invitations per ADR-037."

slug: invitation-flow-implementation
number: "ADR-068"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "When implementing the invitation flow specced in ADR-035..ADR-040, what concrete choices fill in the unspecified parts (URL shape, invitation scope, store layout)?"
chosen: |
  - **Invite URL shape**: `https://<host>/invite/<token>` for v0. The token
    sits in the URL path (not query, not fragment). Rationale: simpler for
    server-side rendering of the redemption form and CLI extraction. Trade:
    tokens land in HTTP server logs unless filtered. Mitigated by the 5-min
    expiry and single-use semantics — a leaked log line is worth nothing once
    the token is used or expires.

    *Future:* PLANNING.md §3.2's fragment shape `…/invite/<slug>#token=…`
    keeps the token out of server logs entirely. Migrate when invitations
    become routine + valuable enough for that hardening.

  - **Invitation scope**: host-level. Redeeming an invitation creates a
    Principal{type:agent} at the host level (not bound to any single Doco).
    The inviter can add the new agent to specific Docos via `Doco.members[]`
    out of band. Per-Doco invitations can be added later as a `scope` field
    on the InvitationToken without breaking the v0 shape.

  - **Single TokenStore**: invitation tokens and session tokens live in the
    same `.doco/tokens.json` file, distinguished by a `kind` field
    (`"invitation" | "session"`). Invitations carry `expires_at` (always set
    to issue + 5 min) and `used: boolean`; sessions carry no expiry by
    default but track `revoked` and `invited_by` (the chain root).

  - **Agent-spawns-agent**: a session-token-authenticated agent can call
    `POST /api/v1/agents/spawn` to create a child Principal{type:agent}.
    The child's `owner_id` is the calling agent. The lint
    [rule_agent_ancestry_terminates_at_human](../rules/rule_01KR441EAJCPF378ZGM9DMDFH0.md)
    walks the chain at validation time — so as long as the original
    invitation came from a human, every descendant transitively traces back.

  - **Revocation**: `POST /api/v1/sessions/:token/revoke` revokes with strict
    cascade per ADR-038 — every session token whose `invited_by` chain passes
    through the revoked token also flips to `revoked: true`.
alternatives:
  - name: Token in URL fragment (#token=…)
    rejected_because: "PLANNING.md prefers this for security; deferred to a follow-up because v0's local-host log surface is the dev's own machine. Path is simpler to test."
  - name: Per-Doco invitations as v0 default
    rejected_because: "Adds a scope field + Doco membership write at redemption time. Host-level v0 is sufficient; per-Doco refinement is a strict superset."
  - name: Separate invitation-store and session-store files
    rejected_because: "Two files to keep consistent. Single tokens.json with a `kind` discriminator is simpler and matches the existing TokenStore."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human
decided_by: torrenegra
decided_at: 2026-05-09T03:30:00Z
superseded_by: decision_01KREMDWG6SWKFHR5P1RDB64NC

created_at: 2026-05-09T03:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: superseded
status: superseded
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-068 — Invitation flow implementation

Operationalizes the invitation-token + session-token model described in
PLANNING.md §3 and pinned by ADR-035..ADR-040. Until this Decision the model
existed only on paper; this fills in the unspecified concrete choices and is
followed by the implementation Action.

## Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/invitations` | Bearer (any human session) | Issue a 5-min single-use invitation token. Returns `{ token, url, expires_at, invited_by }`. |
| `POST` | `/api/v1/invitations/redeem` | Bearer (the invitation token) | Agent self-introduction. Body carries display_name, model, provider, capabilities. Creates Principal{type:agent}, issues session token, marks invitation used. |
| `POST` | `/api/v1/agents/spawn` | Bearer (a session token) | Existing agent creates a child agent Principal. Same response shape as `redeem`. |
| `POST` | `/api/v1/sessions/:token/revoke` | Bearer (any human session) | Revoke a session token with strict cascade. |

## URL shape and the 5-min window

`http://<host>/invite/<token>` — the token is the entire URL identifier.
Issuance returns the URL ready to share. Anyone who has the URL within 5 min
can redeem it once. After redemption (or expiry), the URL 404s.
