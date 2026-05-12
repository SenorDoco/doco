---
id: action_01KR6DKHCJCFBG2P6ZRCYRS74E
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 8 — agent-invitation flow. Built end-to-end issue/redeem/spawn/revoke with strict-cascade revocation per ADR-038, host-level invitation scope per ADR-068, and the human-ancestry invariant per rule_agent_ancestry_terminates_at_human."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ   # claude-opus-4-7 (agent)
verb: implement_invitation_flow
target: doco_01KR441EA0ZDMF0N5DY38GSVS3

intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

decision_ids:
  - decision_01KR441EADRWT85TW0SRR3NNX3   # ADR-068 invitation flow implementation (this Action operationalizes it)
  - decision_01KR441EBPZB0X7K59C411PHAQ   # ADR-035 invitation token model
  - decision_01KR441EBQQZXZ7J304KJF72P0   # ADR-036 username convention {inviter}/{ISO}
  - decision_01KR441EBR170TWHVZMZG0SVZS   # ADR-037 5-min single-use invitation tokens
  - decision_01KR441EBSMYJB6YMTGCRKTVZS   # ADR-038 strict-cascade revocation
  - decision_01KR441EBTZDSJC0PEDTX4QHNE   # ADR-039 session token storage
  - decision_01KR441EBVNSWGHVP39KMWE1ZT   # ADR-040 spawn endpoint (agent-spawns-agent)

inputs:
  triggering_question: |
    The founder pointed out that the original requirements stated:
    "Humans should be able to invite agents to collaborate on Docos
    by sharing a URL that includes a token. That token should expire
    within five minutes but when used should enable the agent to get
    another token that can be stored in the environment so that future
    agents can also use it. Using that token, which shouldn't expire
    by default, the original agent and any subsequent agent should be
    able to create users very quickly in Doco to work on it. The only
    difference between human users and non-human users, other than how
    they can create an account, is that only human users can delete
    Docos."
    Until this Action, only the TokenStore scaffolding existed; the
    actual flow (issue/redeem/spawn/revoke) was missing.
  prior_design:
    - PLANNING.md §3 (token model)
    - decisions/ADR-035..ADR-040 (invitation + session tokens)
    - decisions/ADR-068 (this implementation's choices)

outputs:
  api_endpoints_added:
    - "POST /api/v1/invitations — human issues a 5-min single-use invitation, returns { token, url, expires_at, inviter }"
    - "POST /api/v1/invitations/redeem — agent self-introduction; creates Principal{type:agent, owner_id:inviter}, marks invite used, returns { session_token, principal }"
    - "POST /api/v1/agents/spawn — existing session-token holder creates a child agent Principal; ancestry chain preserved (child.owner_id = caller)"
    - "POST /api/v1/sessions/:token/revoke — human-only; strict cascade (every session whose invited_by chain passes through the revoked token also flips to revoked)"
  source_files_changed:
    - packages/api/src/auth.ts                     # InvitationToken type, issueInvitationToken, resolveInvitation, markInvitationUsed, listOpenInvitations, mkdir-on-save
    - packages/api/src/server.ts                   # 4 endpoints + mode-aware single-Doco gate + auth middleware fix (revoked Bearer no longer falls back to defaultPrincipalId)
    - packages/api/src/__tests__/invitation.test.ts # NEW — 4 tests covering full cycle + cascade + human-only revoke
    - packages/api/src/__tests__/server.test.ts    # rule-count assertion bumped to 8 (Phase 7 backfill)
    - packages/api/package.json                    # added @doco/host, yaml deps
    - packages/api/tsconfig.json                   # added project ref to ../host
    - packages/cli/src/commands/invite.ts          # NEW — `doco invite create [--server <url>] [--token <human-session>]`
    - packages/cli/src/commands/agent.ts           # NEW — `doco agent register --invite-token <t> --display-name <n> --model <m> --provider <p>`
    - packages/cli/src/index.ts                    # registered `invite` + `agent` subcommands
    - packages/web/app/routes/invite.tsx           # NEW — human-facing UI: "Generate invitation" button → shareable URL with copy-to-clipboard + agent recipe code block
    - packages/web/app/routes.ts                   # registered /invite route
    - packages/web/package.json                    # added @doco/api dep
    - packages/web/vite.config.ts                  # added @doco/api to ssr.noExternal
    - packages/core/src/__tests__/loader.test.ts   # bootstrap entity counts updated (intent 6→7, rule 5→8, decision ≥45→≥68, action/reasoning made ≥)
    - packages/index/src/__tests__/build.test.ts   # indexed counts updated to match
  decisions_captured:
    - decisions/decision_01KR441EADRWT85TW0SRR3NNX3.md   # ADR-068
  tests:
    api: "12 passing (8 server + 4 invitation)"
    full_workspace: "all 10 packages green via `pnpm -r test`"
  e2e_curl_verified:
    - "Alice → POST /api/v1/invitations returns shareable 5-min URL"
    - "Agent → POST /api/v1/invitations/redeem creates Principal{type:agent, owner_id:alice}; username=alice/<ISO>"
    - "Agent → POST /api/v1/agents/spawn creates child; child.owner_id = parent agent (chain: child → parent → alice)"
    - "Reusing invitation token → invalid_or_expired_invitation"
    - "Alice → POST /api/v1/sessions/:parent/revoke returns { revoked: 2 } (parent + child via cascade)"
    - "Child token after cascade → invalid_token (auth middleware no longer falls through)"

started_at: 2026-05-09T12:30:00Z
ended_at: 2026-05-09T13:10:00Z

created_at: 2026-05-09T13:10:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA7ABSBBYM1JX3A8429   # tag_userflow — invitation is a multi-step user flow
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Phase 8 — agent-invitation flow

The framework's whole reason to exist is to keep agent ancestry traceable
back to a human. Until this Action that invariant only existed in lints
and prose; nothing actually generated agent Principals. The TokenStore
existed since Phase 4 but lacked the surrounding endpoints, the CLI
commands, the web UI, and any tests that exercised the cycle.

## What changed

### API (Hono, packages/api)

Four endpoints land the invitation lifecycle. The mode-aware gate
(`detectMode(docoRoot)`) keeps these out of single-Doco deployments,
where there's no host to invite agents *to*. The auth middleware was
also tightened: a Bearer token that doesn't resolve no longer falls
through to `defaultPrincipalId` — that silent fallback masked the cascade
revocation in the first E2E run.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/v1/invitations` | session (any human) | Issue a 5-min single-use token; return URL ready to share. |
| `POST /api/v1/invitations/redeem` | the invitation token | Agent self-introduces. Creates Principal{type: agent}, owner_id = inviter, username = `{inviter}/{ISO}`. Marks invite used. Issues session token. |
| `POST /api/v1/agents/spawn` | a session token | Existing agent creates a child agent. owner_id = caller. Preserves the ancestry chain. |
| `POST /api/v1/sessions/:token/revoke` | session (humans only) | Strict cascade per ADR-038: every session whose `invited_by` chain passes through the revoked token also flips to `revoked: true`. |

### CLI (citty, packages/cli)

```
doco invite create [--server http://127.0.0.1:8787] [--token <human-session>]
doco agent register --invite-token <t> --display-name <n> --model <m> --provider <p>
```

The agent command prints `export DOCO_TOKEN=<long-lived>` so the agent
just sources it.

### Web (React Router 7, packages/web)

`/invite` — humans land here, click "Generate invitation", get a copyable
URL plus a code block showing the agent's curl recipe. Open invitations
(unused, unexpired) are listed under the form.

### Tests

- `packages/api/src/__tests__/invitation.test.ts` (NEW) — 4 tests
  - issue → redeem → spawn full cycle (verifies 5-min expiry, single-use,
    ancestry chain `child → parent → alice`)
  - expired invitation rejected (manually expires the token in tokens.json)
  - revocation cascades through the agent ancestry chain (ADR-038)
  - only humans can revoke (agent attempt → 403)
- All 10 packages green via `pnpm -r test`. Bootstrap entity-count
  assertions in `core/loader.test.ts` and `index/build.test.ts` updated
  to match the post–Phase 7 + Phase 8 counts (intent 7, rule 8, decision
  ≥68, action ≥14, reasoning ≥2).

### E2E

Verified end-to-end with curl against a fresh `doco host init`. Final
sequence on a real running server:

1. Alice issues invitation → URL with 5-min expiry.
2. Agent redeems → Principal{type: agent, owner_id: alice} + session token.
3. Agent spawns child → Principal{type: agent, owner_id: parent agent} +
   new session token.
4. Re-using invitation → `invalid_or_expired_invitation`.
5. Alice revokes parent → `{ revoked: 2 }` (parent + child via cascade).
6. Child token after cascade → `invalid_token` on next request.

## Invariants now upheld

- **Human ancestry** ([rule](../rules/rule_01KR441EAJCPF378ZGM9DMDFH0.md)) —
  every agent's `owner_id` chain terminates at a `type: human` Principal,
  because the only way to mint an agent is to redeem a human-issued
  invitation, and `spawn` always sets `owner_id = caller`.
- **Single-use** (ADR-037) — invitations are marked `used: true` on
  redemption; `resolveInvitation` returns null for any later attempt.
- **5-min window** (ADR-037) — `INVITATION_TTL_MS = 5 * 60 * 1000`,
  enforced in `resolveInvitation`.
- **Strict cascade** (ADR-038) — revoking a session token revokes every
  descendant whose `invited_by` chain passes through it. Verified in
  test + curl E2E.
- **Humans-only delete** (rule_only_humans_delete_doco) — out of scope
  for this Action; will be enforced at the delete-Doco endpoint when
  that ships. Today the lint rule covers the static case.

## What was deferred

- **`/invite/<token>` GET page** — the agent-side view that reads the
  token from the URL, prompts for display_name/model/provider, and POSTs
  to `/api/v1/invitations/redeem`. The current web `/invite` page is the
  human-side issuer; the agent side is curl-only for v0 (matches PLANNING.md
  §3.2's "agent extracts the token" expectation). A friendly browser
  redemption form is a follow-up.
- **URL fragment shape (`/invite/<slug>#token=…`)** — ADR-068 deferred
  this hardening; v0 keeps the token in the path.
- **Per-Doco invitation scope** — ADR-068 keeps invitations host-level;
  per-Doco refinement is a strict superset to be added later.
- **`invited_by` chain audit endpoint** — useful for debugging but not
  required for the invariant. Current cascade walks the chain in-process.
